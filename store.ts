// The forge's in-memory store: users, repositories, issues, pull requests, labels.
//
// Everything lives in memory (fast, and the suite drives the whole trial through this one
// process). Nothing here reads a clock, a port or randomness: every timestamp derives from a
// deterministic counter, so two runs of the same trial leave identical state.

/** The viewer: the login the suite's token names (wire.ts's fixed scenario seed). */
export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const VIEWER: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

/** The scenario's other users, for owner lookups (no repo of theirs ever exists here). */
export const USERS: ReadonlyMap<string, User> = new Map<string, User>([
  ['adaiversen', VIEWER],
  ['quinnkeller', { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' }],
  ['olgabauer', { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' }],
  ['dmitriquist', { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' }],
  ['adanovak', { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' }],
  ['zanerossi', { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' }],
  ['pavelcosta', { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' }],
  ['wrenkeller', { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' }],
  ['coraquist', { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' }],
]);

export function userOf(login: string): User | null {
  return USERS.get(login) ?? null;
}

// ---------------------------------------------------------------- deterministic time

/** 2025-01-01T00:00:00Z: every timestamp is this base plus a monotonic counter (seconds). */
export const TIME_BASE_SEC = 1_735_689_600;

let seq = 0;

/** The next sequence number (1-based), for timestamps and creation order. */
export function nextSeq(): number {
  seq += 1;
  return seq;
}

/** An ISO-8601 UTC timestamp for a sequence number. */
export function isoOf(sequence: number): string {
  return new Date((TIME_BASE_SEC + sequence) * 1000).toISOString();
}

/** A git commit timestamp (`<seconds> +0000`) for a sequence number. */
export function gitTimeOf(sequence: number): string {
  return `${TIME_BASE_SEC + sequence} +0000`;
}

// ---------------------------------------------------------------- global (Relay) ids

/** Opaque, stable global ids: base64url of a typed key, decodable for node(id:) and mutations. */
export function globalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    // Re-encoding must round-trip: a non-canonical id is not one of ours.
    if (Buffer.from(text, 'utf8').toString('base64url') !== id) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the model

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  /** The REST numeric id (a global counter, distinct from `number`). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
  /** Cached REST JSON, cleared on any mutation (the read workload's fast path). */
  jsonCache: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  /** The head/base tips at creation (GET refreshes them to the live tips). */
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  /** The numeric database id (GraphQL databaseId, REST id). */
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  /** refname -> oid (refs/heads/* and refs/tags/*). */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
  createdSeq: number;
  updatedSeq: number;
  /** Bumped on every ref change; fetch-pack cache keys include it. */
  refVersion: number;
  /** Fetch-pack cache: signature -> pack bytes (the clone workload's 50 identical clones). */
  fetchCache: Map<string, Buffer>;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** All repositories, keyed `owner/name`, in creation order. */
export const repos = new Map<string, Repo>();

let nextRepoId = 0;
let nextRestId = 0;

/** The next numeric database id for a repository. */
export function nextRepoDbId(): number {
  nextRepoId += 1;
  return nextRepoId;
}

/** The next REST numeric id (issues, pull requests). */
export function nextRestObjectId(): number {
  nextRestId += 1;
  return nextRestId;
}

export function getRepo(owner: string, name: string): Repo | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

export function createRepoRecord(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const now = nextSeq();
  const repo: Repo = {
    id: nextRepoDbId(),
    name,
    owner,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    createdSeq: now,
    updatedSeq: now,
    refVersion: 0,
    fetchCache: new Map(),
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepoRecord(repo: Repo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

/** Bump a repo's ref version (and drop its fetch cache) after any ref change. */
export function touchRefs(repo: Repo): void {
  repo.refVersion += 1;
  repo.fetchCache.clear();
}

/** The viewer-facing repository id helpers. */
export function repoGlobalId(repo: Repo): string {
  return globalId('repo', [repo.id]);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('issue', [repo.id, issue.number]);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('pr', [repo.id, pull.number]);
}

export function commentGlobalId(repo: Repo, comment: Comment): string {
  return globalId('comment', [repo.id, comment.id]);
}

/** Find a repository by its numeric database id (for global-id decoding). */
export function repoByDbId(dbId: number): Repo | null {
  for (const repo of repos.values()) {
    if (repo.id === dbId) return repo;
  }
  return null;
}
