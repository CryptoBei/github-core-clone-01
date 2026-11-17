// Git smart HTTP: info/refs advertisements (v0 + v2), upload-pack (v2 ls-refs/fetch, v0
// fetch fallback) and receive-pack (v0). The wire shapes follow the suite's git-client.ts
// exactly: pkt-line framing, sideband band 1 for packs and push reports, report-status lines.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRepo, touchRefs, type Repo } from './store.ts';
import {
  PKT_FLUSH,
  ZERO_OID,
  buildPack,
  encodePktLines,
  getCommit,
  getObject,
  getTag,
  getTree,
  isAncestor,
  isObjectId,
  objectClosureOfCommits,
  parseAllPktLines,
  parsePack,
  parsePktLines,
  peelToNonTag,
  pktLine,
  putObject,
} from './gitcore.ts';

// ---------------------------------------------------------------- advertisements

const V2_ADVERTISEMENT = encodePktLines([
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
  'flush',
]);

const UPLOAD_V0_CAPS = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow symref=HEAD:refs/heads/main';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** A v0 ref advertisement: service preamble, flush, ref lines (caps on the first), flush. */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    lines.push(`${headTip} HEAD\0${caps}\n`);
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      lines.push(`${oid} ${name}\n`);
      const tag = getTag(oid);
      if (tag !== null) {
        const peeled = peelToNonTag(oid);
        if (peeled !== oid) lines.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string | null,
): void {
  const repo = getRepo(owner, repoName);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, { message: 'unknown service' });
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
    res.end(V2_ADVERTISEMENT);
    return;
  }
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
  res.end(v0Advertisement(service, repo));
}

// ---------------------------------------------------------------- small HTTP helpers (shared with the router)

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

export function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': body.length,
  });
  res.end(body);
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (headTip !== undefined) {
    if (matches('HEAD')) {
      lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  } else if (args.unborn && matches('HEAD')) {
    lines.push(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const tag = getTag(oid);
      if (tag !== null) {
        const peeled = peelToNonTag(oid);
        if (peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  return encodePktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------- fetch (v2 + v0)

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  /** `deepen` counts below the client's shallow boundary, not from the wants. */
  deepenRelative: boolean;
  /** The client sent `done`: it has no more haves to offer, so the packfile may go out. */
  done: boolean;
}

interface FetchPlan {
  sentCommits: Set<string>;
  heldCommits: Set<string>;
  extraObjects: Set<string>;
  shallowOut: string[];
  unshallowOut: string[];
}

function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const shallowSet = new Set(request.shallow);
  // Held: the closure of the haves, stopping at the client's shallow boundary (parents of a
  // shallow commit are NOT held).
  const held = new Set<string>();
  {
    const stack = [...request.haves];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (held.has(current)) continue;
      const commit = getCommit(current);
      if (commit === null) continue;
      held.add(current);
      if (shallowSet.has(current)) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
  }
  // Resolve wants: tags contribute their object and walk from their target; trees/blobs are direct.
  const walkRoots: string[] = [];
  const extraObjects = new Set<string>();
  for (const want of request.wants) {
    const object = getObject(want);
    if (object === null) continue;
    if (object.type === 'commit') walkRoots.push(want);
    else if (object.type === 'tag') {
      extraObjects.add(want);
      let target = getTag(want)?.object;
      while (target !== undefined) {
        const targetObject = getObject(target);
        if (targetObject === null) break;
        if (targetObject.type === 'commit') {
          walkRoots.push(target);
          break;
        }
        if (targetObject.type === 'tag') {
          extraObjects.add(target);
          target = getTag(target)?.object;
          continue;
        }
        extraObjects.add(target);
        break;
      }
    } else {
      extraObjects.add(want);
    }
  }
  // The walk: distance from the wants; depth counts commits (deepen 1 = the tip alone).
  // It descends past held commits unconditionally: the shallow boundary usually sits
  // below held commits, and its parents are not held — stopping at held commits would
  // never reach them (the --unshallow fetch sends nothing otherwise).
  const sent = new Set<string>();
  const distance = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = walkRoots.map((oid) => ({ oid, depth: 0 }));
  const deepen = request.deepen;
  const relative = request.deepenRelative && deepen !== null;
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (distance.has(oid)) continue;
    const commit = getCommit(oid);
    if (commit === null) continue;
    distance.set(oid, depth);
    if (!held.has(oid)) sent.add(oid);
    // Absolute deepen caps the walk from the wants; relative deepen is applied below,
    // against the boundary, so the walk itself is uncapped.
    if (deepen !== null && !relative && depth + 1 >= deepen) continue;
    for (const parent of commit.parents) {
      if (!distance.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  // Relative deepen: a sent commit's depth below the boundary is its shortest distance
  // from any shallow-boundary commit, following parent edges. Commits unreachable from
  // the boundary (new tips above it) have no limit; commits below it are kept only
  // within `deepen` of the boundary.
  let kept = sent;
  let bdepth: Map<string, number> | null = null;
  if (relative) {
    bdepth = new Map<string, number>();
    const bqueue: Array<{ oid: string; depth: number }> = [];
    for (const boundary of shallowSet) {
      if (distance.has(boundary) && !bdepth.has(boundary)) {
        bdepth.set(boundary, 0);
        bqueue.push({ oid: boundary, depth: 0 });
      }
    }
    while (bqueue.length > 0) {
      const { oid, depth } = bqueue.shift() as { oid: string; depth: number };
      const commit = getCommit(oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!distance.has(parent) || bdepth.has(parent)) continue;
        bdepth.set(parent, depth + 1);
        bqueue.push({ oid: parent, depth: depth + 1 });
      }
    }
    kept = new Set<string>();
    for (const oid of sent) {
      const d = bdepth.get(oid);
      if (d === undefined || d <= (deepen as number)) kept.add(oid);
    }
  }
  // New shallow boundary: sent commits at the maximum depth whose parents stay unsent.
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  const available = new Set<string>([...held, ...kept]);
  if (deepen !== null && !relative) {
    for (const oid of kept) {
      if (distance.get(oid) !== deepen - 1) continue;
      const commit = getCommit(oid);
      if (commit === null || commit.parents.length === 0) continue;
      if (commit.parents.some((parent) => !available.has(parent))) shallowOut.push(oid);
    }
  }
  if (relative && bdepth !== null) {
    // The new boundary is the kept commits at exactly `deepen` below the old one.
    for (const oid of kept) {
      if (bdepth.get(oid) !== deepen) continue;
      const commit = getCommit(oid);
      if (commit === null || commit.parents.length === 0) continue;
      if (commit.parents.some((parent) => !available.has(parent))) shallowOut.push(oid);
    }
  }
  // Unshallow: old shallow commits whose parents are all now held or sent. This runs
  // with or without deepen — the --unshallow fetch sends its boundary with no deepen.
  for (const old of shallowSet) {
    const commit = getCommit(old);
    if (commit === null || commit.parents.length === 0) continue;
    if (commit.parents.every((parent) => available.has(parent))) unshallowOut.push(old);
  }
  shallowOut.sort();
  unshallowOut.sort();
  return { sentCommits: kept, heldCommits: held, extraObjects, shallowOut, unshallowOut };
}

function packForPlan(plan: FetchPlan): Buffer {
  const needed = objectClosureOfCommits(plan.sentCommits);
  for (const oid of plan.extraObjects) {
    needed.add(oid);
    const object = getObject(oid);
    if (object !== null && object.type === 'tree') {
      // A directly-wanted tree contributes its whole subtree.
      const stack = [oid];
      while (stack.length > 0) {
        const current = stack.pop() as string;
        const entries = getTree(current);
        if (entries === null) continue;
        for (const entry of entries) {
          needed.add(entry.oid);
          if (entry.mode === '40000') stack.push(entry.oid);
        }
      }
    }
  }
  const have = objectClosureOfCommits(plan.heldCommits);
  const oids: string[] = [];
  for (const oid of needed) if (!have.has(oid)) oids.push(oid);
  return buildPack(oids);
}

/** Sideband band-1 packets carrying `pack`, chunked under the pkt-line limit. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  return parts;
}

/** ACK lines for haves that are ancestors of (or equal to) a want; no NAK, no ready. */
function commonAckLines(request: FetchRequest): string[] {
  const lines: string[] = [];
  for (const have of request.haves) {
    if (getCommit(have) === null) continue;
    const common = request.wants.some((want) => want === have || isAncestor(have, want));
    if (common) lines.push(`ACK ${have}\n`);
  }
  return lines;
}

/** v0 acknowledgment lines: ACKs, or NAK. v0 has no `ready` line (clients reject it). */
function ackLinesV0(request: FetchRequest): string[] {
  const lines = commonAckLines(request);
  if (lines.length === 0) lines.push('NAK\n');
  return lines;
}

/**
 * The acknowledgments section for a fetch with haves and no `done` (null when no
 * section is due: `done` was sent, or there are no haves). Verified against real
 * git 2.43 upload-pack:
 *   - ACK each have the store holds as a commit, in send order (even one unrelated
 *     to the wants); NAK when none exists.
 *   - `ready` when an ACKed have is an ancestor of (or equal to) a want: the server
 *     has a common commit and the packfile may follow.
 *   - Ready: the section ends with a delim, and more sections follow. Not ready:
 *     the section ends with a flush and the response ends here — a delim would
 *     promise more sections and real git dies "expected no other sections to be
 *     sent after no 'ready'".
 */
function ackSection(request: FetchRequest): { bytes: Buffer; ready: boolean } | null {
  if (request.done || request.haves.length === 0) return null;
  const lines: string[] = [];
  let ready = false;
  for (const have of request.haves) {
    if (getCommit(have) === null) continue;
    lines.push(`ACK ${have}\n`);
    if (!ready && request.wants.some((want) => want === have || isAncestor(have, want))) ready = true;
  }
  if (lines.length === 0) lines.push('NAK\n');
  if (ready) {
    lines.push('ready\n');
    return { bytes: encodePktLines(['acknowledgments\n', ...lines, 'delim']), ready: true };
  }
  return { bytes: encodePktLines(['acknowledgments\n', ...lines, 'flush']), ready: false };
}

function fetchResponseV2(repo: Repo, request: FetchRequest): Buffer {
  const key = `${repo.refVersion}|${[...request.wants].sort().join(',')}|${[...request.haves].sort().join(',')}|${[...request.shallow].sort().join(',')}|${request.deepen ?? ''}|${request.deepenRelative ? 'rel' : 'abs'}|${request.done ? 'done' : 'open'}`;
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [];
  const acks = ackSection(request);
  if (acks !== null) {
    parts.push(acks.bytes);
    if (!acks.ready) {
      // No common commit yet: the client will send another request with more haves
      // (or `done`). The response ends with the flush that closed the section.
      const response = Buffer.concat(parts);
      if (repo.fetchCache.size > 512) repo.fetchCache.clear();
      repo.fetchCache.set(key, response);
      return response;
    }
  }
  const plan = planFetch(repo, request);
  const pack = packForPlan(plan);
  if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallowOut) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallowOut) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const response = Buffer.concat(parts);
  if (repo.fetchCache.size > 512) repo.fetchCache.clear();
  repo.fetchCache.set(key, response);
  return response;
}

function fetchResponseV0(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const pack = packForPlan(plan);
  const lines: string[] = [...ackLinesV0(request)];
  for (const oid of plan.shallowOut) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallowOut) lines.push(`unshallow ${oid}\n`);
  const parts: Buffer[] = [encodePktLines(lines), ...sidebandPack(pack), PKT_FLUSH];
  return Buffer.concat(parts);
}

function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const packets = parseAllPktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (command === '' && line.startsWith('command=')) {
      command = line.slice('command='.length).replace(/\n$/, '');
      continue;
    }
    if (!seenDelim) continue; // agent= / object-format= lines before the delimiter
    args.push(line.replace(/\n$/, ''));
  }
  if (command === '') throw new Error('no command= line in the v2 request');
  return { command, args };
}

function parseFetchArgs(args: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg === 'done') request.done = true;
    else if (arg === 'deepen-relative') request.deepenRelative = true;
    else if (arg.startsWith('deepen ')) {
      const depth = Number(arg.slice(7).trim());
      if (Number.isInteger(depth) && depth > 0) request.deepen = depth;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not: accepted, ignored.
  }
  return request;
}

export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = getRepo(owner, repoName);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const contentType = 'application/x-git-upload-pack-result';
  try {
    if ((req.headers['git-protocol'] ?? '') === 'version=2') {
      const { command, args } = parseV2Command(body);
      if (command === 'ls-refs') {
        const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const arg of args) {
          if (arg === 'peel') lsArgs.peel = true;
          else if (arg === 'symrefs') lsArgs.symrefs = true;
          else if (arg === 'unborn') lsArgs.unborn = true;
          else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
        }
        sendBuffer(res, 200, contentType, handleLsRefs(repo, lsArgs));
        return;
      }
      if (command === 'fetch') {
        const request = parseFetchArgs(args);
        // A want the store does not hold is a sideband error, not a crash.
        for (const want of request.wants) {
          if (getObject(want) === null) {
            const errorParts: Buffer[] = [];
            const acks = ackSection(request);
            if (acks !== null) {
              // No `done` yet: answer the negotiation round (the client will come
              // back with `done` and get the error in the packfile section).
              errorParts.push(acks.bytes);
              if (!acks.ready) {
                sendBuffer(res, 200, contentType, Buffer.concat(errorParts));
                return;
              }
            }
            errorParts.push(pktLine('packfile\n'));
            errorParts.push(pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`ERR object ${want} not found\n`, 'utf8')])));
            errorParts.push(PKT_FLUSH);
            sendBuffer(res, 200, contentType, Buffer.concat(errorParts));
            return;
          }
        }
        sendBuffer(res, 200, contentType, fetchResponseV2(repo, request));
        return;
      }
      sendJson(res, 400, { message: `unknown v2 command ${command}` });
      return;
    }
    // Protocol v0 fetch: want/have/shallow/deepen lines in two sections.
    const request = parseV0Fetch(body);
    sendBuffer(res, 200, contentType, fetchResponseV0(repo, request));
  } catch (err) {
    sendJson(res, 400, { message: `malformed git request: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function parseV0Fetch(body: Buffer): FetchRequest {
  const packets = parseAllPktLines(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, done: true };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isInteger(depth) && depth > 0) request.deepen = depth;
    }
  }
  return request;
}

// ---------------------------------------------------------------- receive-pack (v0)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyPushCommand(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || /[\s\u0000-\u001f]/.test(ref)) return { ok: false, reason: 'invalid ref' };
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    repo.refs.delete(ref);
    touchRefs(repo);
    return { ok: true, reason: '' };
  }
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    if (getObject(newOid) === null) return { ok: false, reason: 'invalid object' };
    if (ref.startsWith('refs/heads/') && getCommit(newOid) === null) return { ok: false, reason: 'invalid object' };
    repo.refs.set(ref, newOid);
    touchRefs(repo);
    return { ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
  if (current !== oldOid) return { ok: false, reason: 'non-fast-forward' };
  if (getObject(newOid) === null) return { ok: false, reason: 'invalid object' };
  if (ref.startsWith('refs/heads/') && getCommit(newOid) === null) return { ok: false, reason: 'invalid object' };
  if (newOid !== oldOid && !isAncestor(oldOid, newOid)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(ref, newOid);
  touchRefs(repo);
  return { ok: true, reason: '' };
}

export function handleReceivePack(
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = getRepo(owner, repoName);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const contentType = 'application/x-git-receive-pack-result';
  let commands: PushCommand[];
  let packBytes: Buffer;
  let sideband = true;
  try {
    const { packets, consumed } = parsePktLines(body, 0);
    commands = [];
    let first = true;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (first) {
        first = false;
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          const caps = line.slice(nul + 1).split(' ');
          sideband = caps.includes('side-band-64k');
          line = line.slice(0, nul);
        }
      }
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (match === null) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
    if (commands.length === 0) throw new Error('no push commands');
    packBytes = body.subarray(consumed);
  } catch (err) {
    sendJson(res, 400, { message: `malformed push: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(packBytes);
      for (const [oid, object] of parsed) {
        if (getObject(oid) === null) putObject(object.type, object.data);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  reportLines.push(`unpack ${unpackDetail}\n`);
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const result = applyPushCommand(repo, command);
    reportLines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason}\n`);
  }
  // The report-status stream inside band 1 is itself pkt-lined and must end with its
  // own flush: real git's inner packet reader dies "hung up unexpectedly" on EOF here.
  const inner = encodePktLines([...reportLines, 'flush']);
  let response: Buffer;
  if (sideband) {
    response = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
  } else {
    response = Buffer.concat([inner, PKT_FLUSH]);
  }
  sendBuffer(res, 200, contentType, response);
}
