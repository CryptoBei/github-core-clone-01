// Model Context Protocol over Streamable HTTP: the modern 2026-07-28 era (server/discover,
// no handshake) and the legacy handshake era (initialize + notifications/initialized), six
// tools over the same store the REST surface uses. Every answer is one JSON body; the tools
// list is a constant, so two tools/list calls answer byte for byte the same.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, getRepo, type Repo } from './store.ts';
import {
  createIssueOp,
  createPullOp,
  createRepoOp,
  issueJsonObject,
  mergePullOp,
  pullJson,
  repoJson,
} from './ops.ts';
import { nextRequestId } from './githttp.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The six tools, defined once (tools/list answers this array verbatim, every time). */
const TOOLS: readonly McpTool[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit on its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  }),
]);

const TOOLS_BY_NAME = new Map<string, McpTool>(TOOLS.map((tool) => [tool.name, tool]));

function sendRpc(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendRpc(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, id: unknown, code: number, message: string, status = 200): void {
  sendRpc(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function numberArg(args: Record<string, unknown>, ...names: string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function repoArg(args: Record<string, unknown>): Repo | null {
  const owner = stringArg(args, 'owner', 'owner_login');
  let repoName = stringArg(args, 'repo', 'repository');
  if (repoName === null) {
    const fullName = stringArg(args, 'full_name');
    if (fullName !== null) {
      const slash = fullName.indexOf('/');
      if (slash >= 0) repoName = fullName.slice(slash + 1);
    }
  }
  if (owner === null || repoName === null) return null;
  return getRepo(owner, repoName);
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name', 'repo');
      if (repoName === null) return toolError('create_repo: name is required');
      const result = createRepoOp(VIEWER.login, {
        name: repoName,
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      if (!result.ok) return toolError(`create_repo: ${result.error}`);
      return toolResult(repoJson(result.value));
    }
    case 'get_repo': {
      const repo = repoArg(args);
      if (repo === null) return toolError('get_repo: repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoArg(args);
      if (repo === null) return toolError('create_issue: repository not found');
      const title = stringArg(args, 'title');
      if (title === null) return toolError('create_issue: title is required');
      const result = createIssueOp(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        labels: Array.isArray(args.labels) ? args.labels : undefined,
      });
      if (!result.ok) return toolError(`create_issue: ${result.error}`);
      return toolResult(issueJsonObject(repo, result.value));
    }
    case 'list_issues': {
      const repo = repoArg(args);
      if (repo === null) return toolError('list_issues: repository not found');
      const state = stringArg(args, 'state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return toolResult(list.map((issue) => issueJsonObject(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoArg(args);
      if (repo === null) return toolError('create_pull_request: repository not found');
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head', 'head_branch', 'head_ref');
      const base = stringArg(args, 'base', 'base_branch', 'base_ref');
      if (title === null || head === null || base === null) {
        return toolError('create_pull_request: title, head and base are required');
      }
      const result = createPullOp(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      if (!result.ok) return toolError(`create_pull_request: ${result.error}`);
      return toolResult(pullJson(repo, result.value));
    }
    case 'merge_pull_request': {
      const repo = repoArg(args);
      if (repo === null) return toolError('merge_pull_request: repository not found');
      const number = numberArg(args, 'pull_number', 'pullNumber', 'number');
      if (number === null) return toolError('merge_pull_request: pull_number is required');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`merge_pull_request: pull request #${number} not found`);
      const result = mergePullOp(repo, pull);
      if (!result.ok) return toolError(`merge_pull_request: ${result.error}`);
      return toolResult({ sha: result.value.sha, merged: true, message: result.value.message });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

function findTool(name: string): McpTool | null {
  const exact = TOOLS_BY_NAME.get(name);
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  for (const tool of TOOLS) {
    if (lower.endsWith(tool.name.toLowerCase())) return tool;
  }
  return null;
}

export function handleMcp(_req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700 (the modern era's answer).
    rpcError(res, null, -32700, 'Parse error', 400);
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    rpcError(res, null, -32600, 'Invalid Request');
    return;
  }
  const record = body as Record<string, unknown>;
  const method = record.method;
  const id = record.id;
  const params = (record.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id: acknowledge and say nothing.
  if (id === undefined) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  if (typeof method !== 'string') {
    rpcError(res, id, -32600, 'Invalid Request: method is required');
    return;
  }

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    rpcResult(res, id, {
      supportedVersions: [MODERN_REVISION],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
    return;
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_REVISIONS.includes(offered) ? offered : LEGACY_REVISIONS[0];
    rpcResult(res, id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const tool = findTool(name);
    if (tool === null) {
      rpcError(res, id, -32601, `Method not found: unknown tool ${JSON.stringify(name)}`);
      return;
    }
    const required = (tool.inputSchema.required ?? []) as string[];
    const missing = required.filter((property) => {
      if (property in args && args[property] !== undefined && args[property] !== null) return false;
      // The suite maps synonyms onto the schema; accept the common spellings here too.
      if (property === 'repo' && (args.repository !== undefined || args.full_name !== undefined)) return false;
      if (property === 'owner' && args.owner_login !== undefined) return false;
      if (property === 'pull_number' && (args.pullNumber !== undefined || args.number !== undefined)) return false;
      if (property === 'head' && (args.head_branch !== undefined || args.head_ref !== undefined)) return false;
      if (property === 'base' && (args.base_branch !== undefined || args.base_ref !== undefined)) return false;
      return true;
    });
    if (missing.length > 0) {
      rpcError(res, id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`);
      return;
    }
    rpcResult(res, id, callTool(tool.name, args));
    return;
  }

  rpcError(res, id, -32601, `Method not found: ${method}`);
}
