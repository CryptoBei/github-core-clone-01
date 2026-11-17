// Shared operations: everything REST, GraphQL and MCP do to the store, in one place so the
// three surfaces can never disagree. Each op returns either its value or { error, status }.

import {
  VIEWER,
  createRepoRecord,
  deleteRepoRecord,
  getRepo,
  isoOf,
  nextRestObjectId,
  nextSeq,
  touchRefs,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import {
  buildTree,
  commitList,
  createServerCommit,
  diffLineCounts,
  diffTrees,
  flattenCommit,
  getCommit,
  getObject,
  getTree,
  isObjectId,
  mergeBase,
  peelToNonTag,
  putObject,
  treeLookup,
  treeWithPath,
  type FlatEntry,
  type TreeEntry,
} from './gitcore.ts';

export interface OpError {
  error: string;
  status: number;
}

export type OpResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

function fail<T>(status: number, error: string): OpResult<T> {
  return { ok: false, error, status };
}

function succeed<T>(value: T): OpResult<T> {
  return { ok: true, value };
}

// ---------------------------------------------------------------- refs

/** Resolve a ref name / oid / undefined to a commit oid (null when unresolvable). */
export function resolveRef(repo: Repo, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return peelToCommit(direct);
  const head = repo.refs.get(`refs/heads/${ref}`);
  if (head !== undefined) return peelToCommit(head);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(tag);
  if (isObjectId(ref) && getCommit(ref) !== null) return ref;
  return null;
}

/** Peel a ref target to a commit (tags resolve to their target commit). */
export function peelToCommit(oid: string): string {
  const peeled = peelToNonTag(oid);
  return getCommit(peeled) !== null ? peeled : oid;
}

/** The tip of a branch (null when the branch does not exist). */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

// ---------------------------------------------------------------- repositories

export function createRepoOp(
  owner: string,
  body: { name?: unknown; description?: unknown; private?: unknown },
): OpResult<Repo> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') return fail(422, 'name is required');
  if (name.length > 100) return fail(422, 'name is too long');
  if (getRepo(owner, name) !== null) return fail(422, 'name already exists on this account');
  const description = typeof body.description === 'string' ? body.description : '';
  const isPrivate = body.private === true;
  return succeed(createRepoRecord(owner, name, description, isPrivate));
}

export function deleteRepoOp(repo: Repo): void {
  deleteRepoRecord(repo);
}

export function createBranchOp(repo: Repo, body: { ref?: unknown; sha?: unknown }): OpResult<{ ref: string; sha: string }> {
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
    return fail(422, 'Invalid ref: must start with refs/heads/ or refs/tags/');
  }
  if (!isObjectId(sha) || getObject(sha) === null) return fail(422, 'Object does not exist');
  if (ref.startsWith('refs/heads/') && getCommit(sha) === null) {
    return fail(422, 'Object does not exist');
  }
  if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  touchRefs(repo);
  return succeed({ ref, sha });
}

// ---------------------------------------------------------------- issues

export function createIssueOp(
  repo: Repo,
  body: { title?: unknown; body?: unknown; labels?: unknown },
): OpResult<Issue> {
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return fail(422, 'title is required');
  const text = typeof body.body === 'string' ? body.body : '';
  const labelNames: string[] = [];
  if (body.labels !== undefined) {
    if (!Array.isArray(body.labels)) return fail(422, 'labels must be an array');
    for (const entry of body.labels) {
      const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : undefined;
      if (typeof name !== 'string') return fail(422, 'label names must be strings');
      if (!repo.labels.has(name)) return fail(422, `Label '${name}' does not exist`);
      labelNames.push(name);
    }
  }
  const now = nextSeq();
  const issue: Issue = {
    id: nextRestObjectId(),
    number: repo.nextNumber,
    title,
    body: text,
    state: 'open',
    labels: labelNames,
    comments: [],
    createdSeq: now,
    updatedSeq: now,
    jsonCache: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return succeed(issue);
}

export function patchIssueOp(
  repo: Repo,
  issue: Issue,
  body: { state?: unknown; title?: unknown; body?: unknown; labels?: unknown },
): OpResult<Issue> {
  if (body.state !== undefined) {
    if (body.state !== 'open' && body.state !== 'closed') return fail(422, "state must be 'open' or 'closed'");
    issue.state = body.state;
  }
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return fail(422, 'title must be a string');
    issue.title = body.title;
  }
  if (body.body !== undefined) {
    if (typeof body.body !== 'string') return fail(422, 'body must be a string');
    issue.body = body.body;
  }
  if (body.labels !== undefined) {
    if (!Array.isArray(body.labels)) return fail(422, 'labels must be an array');
    const labelNames: string[] = [];
    for (const entry of body.labels) {
      const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : undefined;
      if (typeof name !== 'string') return fail(422, 'label names must be strings');
      if (!repo.labels.has(name)) return fail(422, `Label '${name}' does not exist`);
      labelNames.push(name);
    }
    issue.labels = labelNames;
  }
  issue.updatedSeq = nextSeq();
  issue.jsonCache = null;
  return succeed(issue);
}

export function addCommentOp(repo: Repo, issue: Issue, body: string): OpResult<Comment> {
  const comment: Comment = { id: repo.nextCommentId, body, createdSeq: nextSeq() };
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  issue.updatedSeq = nextSeq();
  issue.jsonCache = null;
  return succeed(comment);
}

export function createLabelOp(repo: Repo, body: { name?: unknown; color?: unknown }): OpResult<Label> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') return fail(422, 'name is required');
  if (repo.labels.has(name)) return fail(422, 'Label already exists');
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
  const label: Label = { name, color };
  repo.labels.set(name, label);
  return succeed(label);
}

// ---------------------------------------------------------------- pull requests

export function createPullOp(
  repo: Repo,
  body: { title?: unknown; body?: unknown; head?: unknown; base?: unknown },
): OpResult<Pull> {
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return fail(422, 'title is required');
  const text = typeof body.body === 'string' ? body.body : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (head === '') return fail(422, 'head is required');
  const headSha = branchTip(repo, head);
  if (headSha === null) return fail(422, `Head branch '${head}' does not exist`);
  const baseSha = branchTip(repo, base);
  if (baseSha === null) return fail(422, `Base branch '${base}' does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return fail(422, `A pull request already exists for ${head}`);
    }
  }
  const now = nextSeq();
  const pull: Pull = {
    id: nextRestObjectId(),
    number: repo.nextNumber,
    title,
    body: text,
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergeCommitSha: null,
    mergedAt: null,
    createdSeq: now,
    updatedSeq: now,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return succeed(pull);
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The files a pull request changes (diff of merge-base -> head tip). */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(headTip, baseTip);
  const baseTree = base === null ? null : getCommit(base)?.tree ?? null;
  const headTree = getCommit(headTip)?.tree ?? null;
  const diff = diffTrees(baseTree, headTree);
  return diff.map((entry) => {
    const oldData = entry.oldOid === null ? null : getObject(entry.oldOid)?.data ?? null;
    const newData = entry.newOid === null ? null : getObject(entry.newOid)?.data ?? null;
    const counts = diffLineCounts(oldData, newData);
    return {
      filename: entry.path,
      status: entry.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    };
  });
}

/** A tree rebuilt from a flat path map. */
export function treeFromFlat(entries: ReadonlyMap<string, FlatEntry>): string {
  const build = (paths: Array<readonly [string, FlatEntry]>): string => {
    const grouped = new Map<string, Array<readonly [string, FlatEntry]>>();
    const files: TreeEntry[] = [];
    for (const [path, entry] of paths) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        files.push({ mode: entry.mode, name: path, oid: entry.oid });
      } else {
        const dir = path.slice(0, slash);
        const list = grouped.get(dir) ?? [];
        list.push([path.slice(slash + 1), entry] as const);
        grouped.set(dir, list);
      }
    }
    for (const [dir, sub] of grouped) files.push({ mode: '40000', name: dir, oid: build(sub) });
    return putObject('tree', buildTree(files));
  };
  return build([...entries.entries()]);
}

export interface MergeCheck {
  mergeable: boolean;
  conflicts: string[];
  /** The merged tree's oid when mergeable (null when conflicted or unresolvable). */
  mergedTree: string | null;
  baseTip: string | null;
  headTip: string | null;
  mergeBaseOid: string | null;
}

/** The three-way merge check: file-level, base = merge-base, head vs base-tip. */
export function checkMergeable(repo: Repo, pull: Pull): MergeCheck {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(headTip, baseTip);
  if (base === null || getCommit(headTip) === null || getCommit(baseTip) === null) {
    return { mergeable: false, conflicts: [], mergedTree: null, baseTip, headTip, mergeBaseOid: base };
  }
  const baseFiles = flattenCommit(base);
  const headFiles = flattenCommit(headTip);
  const targetFiles = flattenCommit(baseTip);
  const conflicts: string[] = [];
  const merged = new Map<string, FlatEntry>(targetFiles);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const before = baseFiles.get(path);
    const head = headFiles.get(path);
    const target = targetFiles.get(path);
    const headChanged = (head?.oid ?? null) !== (before?.oid ?? null) || (head?.mode ?? null) !== (before?.mode ?? null);
    const targetChanged = (target?.oid ?? null) !== (before?.oid ?? null) || (target?.mode ?? null) !== (before?.mode ?? null);
    if (!headChanged) continue;
    if (!targetChanged) {
      if (head === undefined) merged.delete(path);
      else merged.set(path, head);
      continue;
    }
    // Both changed: identical changes are fine, anything else conflicts.
    if ((head?.oid ?? null) === (target?.oid ?? null) && (head?.mode ?? null) === (target?.mode ?? null)) continue;
    conflicts.push(path);
  }
  if (conflicts.length > 0) {
    return { mergeable: false, conflicts, mergedTree: null, baseTip, headTip, mergeBaseOid: base };
  }
  return { mergeable: true, conflicts: [], mergedTree: treeFromFlat(merged), baseTip, headTip, mergeBaseOid: base };
}

export function mergePullOp(repo: Repo, pull: Pull): OpResult<{ sha: string; message: string }> {
  if (pull.merged || pull.state === 'closed') return fail(405, 'Pull request has already been merged');
  const check = checkMergeable(repo, pull);
  if (!check.mergeable || check.mergedTree === null || check.baseTip === null) {
    return fail(405, 'Merge conflict: the pull request cannot be merged cleanly');
  }
  const message = pull.title;
  const sha = createServerCommit(check.baseTip, check.mergedTree, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  touchRefs(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = isoOf(nextSeq());
  pull.updatedSeq = nextSeq();
  pull.baseSha = sha;
  return succeed({ sha, message });
}

// ---------------------------------------------------------------- contents

export interface ContentsPutResult {
  status: 200 | 201;
  contentSha: string;
  commitSha: string;
  size: number;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.');
}

export function contentsPutOp(
  repo: Repo,
  path: string,
  body: { message?: unknown; content?: unknown; branch?: unknown; sha?: unknown },
): OpResult<ContentsPutResult> {
  const segments = splitPath(path);
  if (segments.length === 0) return fail(422, 'path is required');
  if (segments.some((segment) => segment === '..')) return fail(422, 'path must not contain ..');
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  if (typeof body.content !== 'string') return fail(422, 'content is required');
  const data = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  let parent = branchTip(repo, branch);
  if (parent === null) {
    // A contents write on a branch that does not exist yet starts it from the default tip
    // (or from nothing when the repository is still empty).
    parent = branch === repo.defaultBranch ? null : branchTip(repo, repo.defaultBranch);
  }
  const parentTree = parent === null ? null : getCommit(parent)?.tree ?? null;
  const current = parentTree === null ? null : treeLookup(parentTree, segments);
  const isUpdate = current !== null && current.mode !== '40000';
  if (current !== null && current.mode === '40000') return fail(422, 'path is a directory');
  if (isUpdate) {
    if (typeof body.sha !== 'string' || body.sha === '') return fail(422, "sha wasn't supplied");
    if (body.sha.toLowerCase() !== current.oid.toLowerCase()) {
      return fail(409, 'sha does not match the current blob');
    }
  }
  const blobOid = putObject('blob', data);
  const treeOid = treeWithPath(parentTree, segments, blobOid);
  const commitSha = createServerCommit(parent, treeOid, message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  touchRefs(repo);
  return succeed({ status: isUpdate ? 200 : 201, contentSha: blobOid, commitSha, size: data.length });
}

export function contentsDeleteOp(
  repo: Repo,
  path: string,
  body: { message?: unknown; branch?: unknown; sha?: unknown },
): OpResult<{ commitSha: string }> {
  const segments = splitPath(path);
  if (segments.length === 0) return fail(422, 'path is required');
  const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const parent = branchTip(repo, branch);
  if (parent === null) return fail(404, 'Not Found');
  const parentTree = getCommit(parent)?.tree ?? null;
  if (parentTree === null) return fail(404, 'Not Found');
  const current = treeLookup(parentTree, segments);
  if (current === null || current.mode === '40000') return fail(404, 'Not Found');
  if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== current.oid.toLowerCase()) {
    return fail(409, 'sha does not match the current blob');
  }
  const treeOid = treeWithPath(parentTree, segments, null);
  const commitSha = createServerCommit(parent, treeOid, message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  touchRefs(repo);
  return succeed({ commitSha });
}

export type ContentsGetResult =
  | { kind: 'file'; name: string; path: string; sha: string; size: number; content: Buffer }
  | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }> };

export function contentsGetOp(repo: Repo, path: string, ref: string | null): OpResult<ContentsGetResult> {
  const commitOid = resolveRef(repo, ref);
  if (commitOid === null) return fail(404, 'Not Found');
  const treeOid = getCommit(commitOid)?.tree ?? null;
  if (treeOid === null) return fail(404, 'Not Found');
  const segments = splitPath(path);
  if (segments.length === 0) {
    const entries = getTree(treeOid) ?? [];
    return succeed({
      kind: 'dir',
      entries: entries.map((entry) => ({
        type: (entry.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (getObject(entry.oid)?.data.length ?? 0),
      })),
    });
  }
  const found = treeLookup(treeOid, segments);
  if (found === null) return fail(404, 'Not Found');
  if (found.mode === '40000') {
    const entries = getTree(found.oid) ?? [];
    return succeed({
      kind: 'dir',
      entries: entries.map((entry) => ({
        type: (entry.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
        name: entry.name,
        path: `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (getObject(entry.oid)?.data.length ?? 0),
      })),
    });
  }
  const blob = getObject(found.oid);
  if (blob === null || blob.type !== 'blob') return fail(404, 'Not Found');
  return succeed({
    kind: 'file',
    name: segments[segments.length - 1] as string,
    path,
    sha: found.oid,
    size: blob.data.length,
    content: blob.data,
  });
}

// ---------------------------------------------------------------- serializers

export function userJson(user: { login: string; id: number }): Record<string, unknown> {
  return { login: user.login, id: user.id, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson({ login: repo.owner, id: VIEWER.login === repo.owner ? VIEWER.id : 0 }),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdSeq),
    updated_at: isoOf(repo.updatedSeq),
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

export function issueJsonObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: userJson(VIEWER),
    created_at: isoOf(issue.createdSeq),
    updated_at: isoOf(issue.updatedSeq),
    comments: issue.comments.length,
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedSeq) : null,
  };
}

/** The REST issue JSON, cached on the issue (cleared by every mutation). */
export function issueJsonString(repo: Repo, issue: Issue): string {
  if (issue.jsonCache === null) issue.jsonCache = JSON.stringify(issueJsonObject(repo, issue));
  return issue.jsonCache;
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(VIEWER),
    created_at: isoOf(comment.createdSeq),
    updated_at: isoOf(comment.createdSeq),
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
    user: userJson(VIEWER),
    created_at: isoOf(pull.createdSeq),
    updated_at: isoOf(pull.updatedSeq),
  };
}

export function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

function parseIdentity(text: string): { name: string; email: string; date: string } {
  const match = /^(.+) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', date: '' };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

export function commitJson(oid: string): Record<string, unknown> | null {
  const commit = getCommit(oid);
  if (commit === null) return null;
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    tree: { sha: commit.tree },
  };
}

export function listCommits(repo: Repo, ref: string | null): OpResult<Array<Record<string, unknown>>> {
  const tip = resolveRef(repo, ref);
  if (tip === null) return fail(404, 'Not Found');
  const out: Array<Record<string, unknown>> = [];
  for (const oid of commitList(tip, 100)) {
    const json = commitJson(oid);
    if (json !== null) out.push(json);
  }
  return succeed(out);
}
