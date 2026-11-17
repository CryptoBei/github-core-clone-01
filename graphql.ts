// GitHub GraphQL v4: a hand-written parser and executor for the documents gh and
// github-mcp-server send (the 17 fixed documents in checks-graphql.ts, plus the shapes they
// imply). No GraphQL library: the parser is a small recursive descent over the query language,
// the executor resolves against the same store the REST surface uses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, getRepo, isoOf, nextSeq, parseGlobalId, repoByDbId, type Issue, type Pull, type Repo } from './store.ts';
import {
  addCommentOp,
  checkMergeable,
  createIssueOp,
  createPullOp,
  mergePullOp,
  pullFiles,
} from './ops.ts';
import { sendJson } from './githttp.ts';

// ---------------------------------------------------------------- parser

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
}

class GraphQLSyntaxError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',' || ch === '﻿') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...', line });
      index += 3;
      continue;
    }
    if ('{}():$!@=[]|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, line });
      index += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") and quoted strings.
      if (source.slice(index, index + 3) === '"""') {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new GraphQLSyntaxError('unterminated block string');
        const raw = source.slice(index + 3, end);
        line += (raw.match(/\n/g) ?? []).length;
        tokens.push({ kind: 'string', value: raw, line });
        index = end + 3;
        continue;
      }
      let value = '';
      index += 1;
      let closed = false;
      while (index < source.length) {
        const c = source[index] as string;
        if (c === '"') {
          closed = true;
          index += 1;
          break;
        }
        if (c === '\n') throw new GraphQLSyntaxError('unterminated string');
        if (c === '\\') {
          const esc = source[index + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16));
            index += 6;
          } else if (map[esc] !== undefined) {
            value += map[esc];
            index += 2;
          } else {
            throw new GraphQLSyntaxError(`bad escape \\${esc}`);
          }
          continue;
        }
        value += c;
        index += 1;
      }
      if (!closed) throw new GraphQLSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value, line });
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      let end = index;
      if (source[end] === '-') end += 1;
      while (end < source.length && isDigit(source[end] as string)) end += 1;
      let isFloat = false;
      if (source[end] === '.' && isDigit(source[end + 1] as string)) {
        isFloat = true;
        end += 1;
        while (end < source.length && isDigit(source[end] as string)) end += 1;
      }
      if (source[end] === 'e' || source[end] === 'E') {
        isFloat = true;
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && isDigit(source[end] as string)) end += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(index, end), line });
      index = end;
      continue;
    }
    if (isNameStart(ch)) {
      let end = index;
      while (end < source.length && isNameChar(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end), line });
      index = end;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)} on line ${line}`);
  }
  tokens.push({ kind: 'eof', value: '', line });
  return tokens;
}

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}

export interface GqlSpread {
  kind: 'spread';
  name: string;
}

export interface GqlInline {
  kind: 'inline';
  typeCondition: string | null;
  selections: GqlSelection[];
}

export type GqlSelection = GqlField | GqlSpread | GqlInline;

export interface GqlVarDef {
  name: string;
  type: string;
  defaultValue: GqlValue | null;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: GqlVarDef[];
  selections: GqlSelection[];
}

export interface GqlFragment {
  name: string;
  typeCondition: string;
  selections: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlFragment>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)} on line ${token.line}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLSyntaxError(`expected a name, got ${JSON.stringify(token.value)} on line ${token.line}`);
    if (value !== undefined && token.value !== value) {
      throw new GraphQLSyntaxError(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)} on line ${token.line}`);
    }
    return token.value;
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlFragment>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        this.parseDirectives();
        operations.push({ kind, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new GraphQLSyntaxError(`unexpected token ${JSON.stringify(token.value)} on line ${token.line}`);
    }
    return { operations, fragments };
  }

  private parseVarDefs(): GqlVarDef[] {
    const defs: GqlVarDef[] = [];
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: GqlValue | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue(true);
      this.parseDirectives();
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private parseType(): string {
    let type: string;
    if (this.acceptPunct('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.acceptPunct('!')) type += '!';
    return type;
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.parseDirectives();
        return { kind: 'spread', name };
      }
      this.parseDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.parseDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue(false);
    }
    return args;
  }

  private parseValue(isConst: boolean): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new GraphQLSyntaxError('a variable is not allowed in a constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!this.acceptPunct(']')) items.push(this.parseValue(isConst));
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      return { kind: 'object', fields };
    }
    throw new GraphQLSyntaxError(`unexpected value token ${JSON.stringify(token.value)} on line ${token.line}`);
  }
}

export function parseGraphQL(source: string): GqlDocument {
  return new Parser(source).parseDocument();
}

// ---------------------------------------------------------------- schema

/** The fields each type exposes (also the introspection lists and the validator's table). */
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged',
    'files', 'createdAt', 'updatedAt',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Comment: ['id', 'body'],
  CommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  Node: ['id'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
});

/** The object type a field returns (for validation of nested selections). */
const FIELD_TYPE: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  PullRequest: { files: 'PullRequestFileConnection' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequestFileConnection: { nodes: 'PullRequestFile', pageInfo: 'PageInfo' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CommentEdge: { node: 'Comment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
});

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

// ---------------------------------------------------------------- values

type Resolved = Record<string, unknown> & { __typename: string };

function valueOf(value: GqlValue, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: GqlField, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(field.args)) out[name] = valueOf(value, variables);
  return out;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// ---------------------------------------------------------------- validation

function validateSelections(
  selections: readonly GqlSelection[],
  typeName: string,
  document: GqlDocument,
  errors: string[],
  seenFragments: Set<string>,
): void {
  const fields = TYPE_FIELDS[typeName] ?? [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (!fields.includes(selection.name)) {
        errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
        continue;
      }
      if (selection.selections.length > 0) {
        const childType = FIELD_TYPE[typeName]?.[selection.name];
        if (childType !== undefined) {
          validateSelections(selection.selections, childType, document, errors, new Set(seenFragments));
        }
      }
    } else if (selection.kind === 'inline') {
      const target = selection.typeCondition ?? typeName;
      validateSelections(selection.selections, target, document, errors, new Set(seenFragments));
    } else {
      const fragment = document.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push(`Unknown fragment "${selection.name}".`);
        continue;
      }
      if (seenFragments.has(fragment.name)) continue;
      seenFragments.add(fragment.name);
      validateSelections(fragment.selections, fragment.typeCondition, document, errors, seenFragments);
    }
  }
}

// ---------------------------------------------------------------- cursors

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberOfCursor(cursor: string | null): number | null {
  if (cursor === null || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = Number(text.slice('cursor:'.length));
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- resolvers

interface Ctx {
  variables: Readonly<Record<string, unknown>>;
  document: GqlDocument;
}

function userNode(): Resolved {
  return { __typename: 'User', login: VIEWER.login, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email };
}

function repoNode(repo: Repo): Resolved {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: Buffer.from(`repo:${repo.id}`, 'utf8').toString('base64url'),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: isoOf(repo.createdSeq),
    updatedAt: isoOf(repo.updatedSeq),
  };
}

function issueNode(repo: Repo, issue: Issue): Resolved {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: Buffer.from(`issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: isoOf(issue.createdSeq),
    updatedAt: isoOf(issue.updatedSeq),
  };
}

function pullNode(repo: Repo, pull: Pull): Resolved {
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: Buffer.from(`pr:${repo.id}:${pull.number}`, 'utf8').toString('base64url'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    state,
    merged: pull.merged,
    createdAt: isoOf(pull.createdSeq),
    updatedAt: isoOf(pull.updatedSeq),
  };
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): Resolved {
  return {
    __typename: 'PageInfo',
    hasNextPage,
    endCursor,
    hasPreviousPage: false,
    startCursor,
  };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Resolved {
  let list = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((s): s is string => typeof s === 'string') : null;
  if (states !== null) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'ASC' : orderBy.direction === 'DESC' ? 'DESC' : null;
  if (direction === 'DESC') list.sort((a, b) => b.number - a.number);
  else list.sort((a, b) => a.number - b.number);
  const afterNumber = numberOfCursor(asString(args.after));
  if (afterNumber !== null) {
    const index = list.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) list = list.slice(index + 1);
  }
  const first = asInt(args.first);
  const total = list.length;
  const page = first === null ? list : list.slice(0, Math.max(0, first));
  const hasNextPage = first !== null && total > page.length;
  const endCursor = page.length > 0 ? cursorOf((page[page.length - 1] as Issue).number) : null;
  const startCursor = page.length > 0 ? cursorOf((page[0] as Issue).number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: pageInfoNode(hasNextPage, endCursor, startCursor),
    totalCount: total,
  };
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): Resolved {
  let list = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((s): s is string => typeof s === 'string') : ['OPEN'];
  list = list.filter((pull) => {
    const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    return states.includes(state);
  });
  list.sort((a, b) => b.number - a.number);
  const first = asInt(args.first);
  const total = list.length;
  const page = first === null ? list : list.slice(0, Math.max(0, first));
  const hasNextPage = first !== null && total > page.length;
  const endCursor = page.length > 0 ? cursorOf((page[page.length - 1] as Pull).number) : null;
  const startCursor = page.length > 0 ? cursorOf((page[0] as Pull).number) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullNode(repo, pull)),
    pageInfo: pageInfoNode(hasNextPage, endCursor, startCursor),
    totalCount: total,
  };
}

function filesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Resolved {
  const files = pullFiles(repo, pull);
  const first = asInt(args.first);
  const page = first === null ? files : files.slice(0, Math.max(0, first));
  const hasNextPage = first !== null && files.length > page.length;
  return {
    __typename: 'PullRequestFileConnection',
    nodes: page.map((file) => ({ __typename: 'PullRequestFile', path: file.filename })),
    pageInfo: pageInfoNode(hasNextPage, null, null),
    totalCount: files.length,
  };
}

function typeNode(name: string): Resolved | null {
  if (name === 'SearchType') {
    return {
      __typename: '__Type',
      name: 'SearchType',
      kind: 'ENUM',
      __fields: [] as string[],
      __enumValues: SEARCH_TYPE_VALUES,
    };
  }
  const fields = TYPE_FIELDS[name];
  if (fields === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: 'OBJECT',
    __fields: [...fields],
    __enumValues: [] as string[],
  };
}

/** Resolve one field on a resolved object (scalars, objects, connections, mutations). */
function resolveField(parent: Resolved, field: GqlField, ctx: Ctx): unknown {
  const args = argsOf(field, ctx.variables);
  const type = parent.__typename;
  if (field.name === '__typename') return type;

  if (type === 'Query') {
    if (field.name === 'viewer') return userNode();
    if (field.name === 'repository') {
      const owner = asString(args.owner);
      const name = asString(args.name);
      if (owner === null || name === null) return null;
      const repo = getRepo(owner, name);
      return repo === null ? null : repoNode(repo);
    }
    if (field.name === 'node') {
      const id = asString(args.id);
      if (id === null) return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'repo') {
        const repo = repoByDbId(Number(parsed.parts[0]));
        return repo === null ? null : repoNode(repo);
      }
      if (parsed.kind === 'issue') {
        const repo = repoByDbId(Number(parsed.parts[0]));
        const issue = repo?.issues.get(Number(parsed.parts[1]));
        return repo !== undefined && repo !== null && issue !== undefined ? issueNode(repo, issue) : null;
      }
      if (parsed.kind === 'pr') {
        const repo = repoByDbId(Number(parsed.parts[0]));
        const pull = repo?.pulls.get(Number(parsed.parts[1]));
        return repo !== undefined && repo !== null && pull !== undefined ? pullNode(repo, pull) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = asString(args.name);
      return name === null ? null : typeNode(name);
    }
    return undefined;
  }

  if (type === 'Mutation') {
    return resolveMutation(field, args);
  }

  if (type === 'Repository') {
    const repo = parent.__repo as Repo;
    if (field.name === 'owner') return userNode();
    if (field.name === 'defaultBranchRef') {
      return { __typename: 'Ref', name: repo.defaultBranch };
    }
    if (field.name === 'issue') {
      const number = asInt(args.number);
      if (number === null) return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueNode(repo, issue);
    }
    if (field.name === 'issues') return issuesConnection(repo, args);
    if (field.name === 'pullRequests') return pullRequestsConnection(repo, args);
    if (field.name === 'pullRequest') {
      const number = asInt(args.number);
      if (number === null) return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullNode(repo, pull);
    }
    return parent[field.name];
  }

  if (type === 'PullRequest') {
    const repo = parent.__repo as Repo;
    const pull = parent.__pull as Pull;
    if (field.name === 'mergeable') {
      if (pull.state !== 'open') return 'UNKNOWN';
      return checkMergeable(repo, pull).mergeable ? 'MERGEABLE' : 'CONFLICTING';
    }
    if (field.name === 'files') return filesConnection(repo, pull, args);
    if (field.name === 'headRefName') return pull.headRef;
    if (field.name === 'baseRefName') return pull.baseRef;
    return parent[field.name];
  }

  if (type === '__Type') {
    if (field.name === 'fields') {
      return ((parent.__fields as string[]) ?? []).map((name) => ({ __typename: '__Field', name }));
    }
    if (field.name === 'enumValues') {
      return ((parent.__enumValues as string[]) ?? []).map((name) => ({ __typename: '__EnumValue', name }));
    }
    return parent[field.name];
  }

  // Scalar leaf fields and pre-resolved children (connections, payloads, edges).
  return parent[field.name];
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function repoFromGlobalId(id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'repo') return null;
  return repoByDbId(Number(parsed.parts[0]));
}

function resolveMutation(field: GqlField, args: Record<string, unknown>): Resolved | null {
  const input = inputOf(args);
  if (field.name === 'createIssue') {
    const repo = repoFromGlobalId(asString(input.repositoryId) ?? '');
    if (repo === null) throw new GraphQLError('createIssue: unknown repositoryId');
    const result = createIssueOp(repo, { title: input.title, body: input.body });
    if (!result.ok) throw new GraphQLError(`createIssue: ${result.error}`);
    return { __typename: 'CreateIssuePayload', issue: issueNode(repo, result.value) };
  }
  if (field.name === 'closeIssue') {
    const parsed = parseGlobalId(asString(input.issueId) ?? '');
    if (parsed === null || parsed.kind !== 'issue') throw new GraphQLError('closeIssue: unknown issueId');
    const repo = repoByDbId(Number(parsed.parts[0]));
    const issue = repo?.issues.get(Number(parsed.parts[1]));
    if (repo === null || issue === undefined) throw new GraphQLError('closeIssue: unknown issueId');
    issue.state = 'closed';
    issue.updatedSeq = nextSeq();
    issue.jsonCache = null;
    return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const repo = repoFromGlobalId(asString(input.repositoryId) ?? '');
    if (repo === null) throw new GraphQLError('createPullRequest: unknown repositoryId');
    const result = createPullOp(repo, {
      title: input.title,
      body: input.body,
      head: input.headRefName,
      base: input.baseRefName,
    });
    if (!result.ok) throw new GraphQLError(`createPullRequest: ${result.error}`);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, result.value) };
  }
  if (field.name === 'mergePullRequest') {
    const parsed = parseGlobalId(asString(input.pullRequestId) ?? '');
    if (parsed === null || parsed.kind !== 'pr') throw new GraphQLError('mergePullRequest: unknown pullRequestId');
    const repo = repoByDbId(Number(parsed.parts[0]));
    const pull = repo?.pulls.get(Number(parsed.parts[1]));
    if (repo === null || pull === undefined) throw new GraphQLError('mergePullRequest: unknown pullRequestId');
    const result = mergePullOp(repo, pull);
    if (!result.ok) throw new GraphQLError(`mergePullRequest: ${result.error}`);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
  }
  if (field.name === 'addComment') {
    const parsed = parseGlobalId(asString(input.subjectId) ?? '');
    if (parsed === null || parsed.kind !== 'issue') throw new GraphQLError('addComment: unknown subjectId');
    const repo = repoByDbId(Number(parsed.parts[0]));
    const issue = repo?.issues.get(Number(parsed.parts[1]));
    if (repo === null || issue === undefined) throw new GraphQLError('addComment: unknown subjectId');
    const result = addCommentOp(repo, issue, typeof input.body === 'string' ? input.body : '');
    if (!result.ok) throw new GraphQLError(`addComment: ${result.error}`);
    const comment = result.value;
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'CommentEdge',
        node: {
          __typename: 'Comment',
          id: Buffer.from(`comment:${repo.id}:${comment.id}`, 'utf8').toString('base64url'),
          body: comment.body,
        },
      },
    };
  }
  return null;
}

class GraphQLError extends Error {}

// ---------------------------------------------------------------- execution

function executeSelections(
  selections: readonly GqlSelection[],
  parent: Resolved,
  ctx: Ctx,
  seenFragments: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.document.fragments.get(selection.name);
      if (fragment === undefined || seenFragments.has(fragment.name)) continue;
      if (fragment.typeCondition !== parent.__typename && fragment.typeCondition !== 'Node') continue;
      seenFragments.add(fragment.name);
      Object.assign(out, executeSelections(fragment.selections, parent, ctx, seenFragments));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(selection.selections, parent, ctx, new Set(seenFragments)));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(parent, selection, ctx);
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: GqlField, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => completeValue(entry, field, ctx));
  }
  if (typeof value === 'object') {
    const node = value as Resolved;
    if (typeof node.__typename === 'string') {
      if (field.selections.length === 0) return null;
      return executeSelections(field.selections, node, ctx, new Set());
    }
    return value;
  }
  return value;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(
  query: string,
  variables: Readonly<Record<string, unknown>>,
  operationName: string | null,
): GraphQLResult {
  let document: GqlDocument;
  try {
    document = parseGraphQL(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: GqlOperation | undefined;
  if (operationName !== null) {
    operation = document.operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else {
    if (document.operations.length !== 1) {
      return { data: null, errors: [{ message: 'This anonymous operation must be the only defined operation.' }] };
    }
    operation = document.operations[0];
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(operation.selections, rootType, document, errors, new Set());
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const mergedVariables: Record<string, unknown> = {};
  for (const varDef of operation.varDefs) {
    if (variables[varDef.name] !== undefined) mergedVariables[varDef.name] = variables[varDef.name];
    else if (varDef.defaultValue !== null) mergedVariables[varDef.name] = valueOf(varDef.defaultValue, variables);
    else mergedVariables[varDef.name] = null;
  }
  for (const [name, value] of Object.entries(variables)) {
    if (!(name in mergedVariables)) mergedVariables[name] = value;
  }
  const ctx: Ctx = { variables: mergedVariables, document };
  const root: Resolved = { __typename: rootType };
  try {
    const data = executeSelections(operation.selections, root, ctx, new Set());
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
}

// ---------------------------------------------------------------- HTTP handler

export function handleGraphQL(_req: IncomingMessage, res: ServerResponse, body: unknown): void {
  const runOne = (entry: unknown): GraphQLResult => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'The request body must be a JSON object with a query string.' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'The request body must carry a query string.' }] };
    }
    const variables = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
      ? (record.variables as Record<string, unknown>)
      : {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    return executeGraphQL(query, variables, operationName);
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(body));
}
