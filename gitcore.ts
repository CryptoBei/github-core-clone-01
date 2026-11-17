// The git engine: object hashing, pkt-lines, packfiles (parse + build, deltas included),
// commit/tree parsing, ancestry, tree flattening and diffs. Pure functions over a global
// content-addressed object store; no I/O, no clock, no git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER, gitTimeOf, nextSeq } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** The global content-addressed object store (objects are immutable; reachability is per-repo). */
export const objects = new Map<string, GitObject>();

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `type` + `data` (`<type> <len>\0<data>` hashed with SHA-1). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object (deduplicated) and answer its id. */
export function putObject(type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | null {
  return objects.get(oid) ?? null;
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 lowercase hex digits of the total length (itself included) + the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new Error(`pkt-line payload of ${data.length} bytes exceeds the 65520 limit`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a list of lines ('flush' / 'delim' for the control packets). */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/**
 * Parse pkt-lines from `buf` starting at `start`, stopping at the first flush (inclusive) or at
 * the end of the buffer. Returns the packets and how many bytes were consumed, so a caller can
 * treat the remainder as raw bytes (a packfile after a receive-pack command list).
 */
export function parsePktLines(buf: Buffer, start = 0): { packets: PktPacket[]; consumed: number } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lengthText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new Error(`bad pkt-line length ${JSON.stringify(lengthText)}`);
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset - start };
}

/** Parse a whole buffer of pkt-lines (no trailing raw bytes allowed). */
export function parseAllPktLines(buf: Buffer): PktPacket[] {
  const { packets, consumed } = parsePktLines(buf, 0);
  if (consumed !== buf.length) {
    // A second section follows (a v2 fetch request is one stream); parse the rest too.
    let offset = consumed;
    while (offset < buf.length) {
      const part = parsePktLines(buf, offset);
      packets.push(...part.packets);
      offset += part.consumed;
    }
  }
  return packets;
}

// ---------------------------------------------------------------- commits, trees, tags

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface ParsedTag {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

const commitCache = new Map<string, ParsedCommit>();
const treeCache = new Map<string, TreeEntry[]>();
const tagCache = new Map<string, ParsedTag>();

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function getCommit(oid: string): ParsedCommit | null {
  const cached = commitCache.get(oid);
  if (cached !== undefined) return cached;
  const object = objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  commitCache.set(oid, parsed);
  return parsed;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree entry (no space)');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry (no NUL/oid)');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function getTree(oid: string): TreeEntry[] | null {
  const cached = treeCache.get(oid);
  if (cached !== undefined) return cached;
  const object = objects.get(oid);
  if (object === undefined || object.type !== 'tree') return null;
  const parsed = parseTree(object.data);
  treeCache.set(oid, parsed);
  return parsed;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function getTag(oid: string): ParsedTag | null {
  const cached = tagCache.get(oid);
  if (cached !== undefined) return cached;
  const object = objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const parsed = parseTag(object.data);
  tagCache.set(oid, parsed);
  return parsed;
}

/** Follow tag objects to the final non-tag object (for peeled refs). */
export function peelToNonTag(oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const tag = getTag(current);
    if (tag === null) return current;
    if (seen.has(current)) return current;
    seen.add(current);
    current = tag.object;
  }
}

/** Git's tree sort: entries by name, directories as if the name ended with '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = sortTreeEntries([...entries]);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(commit: {
  tree: string;
  parents: readonly string[];
  message: string;
  author?: string;
  committer?: string;
}): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  const identity = `${VIEWER.name} <${VIEWER.email}> ${gitTimeOf(nextSeq())}`;
  lines.push(`author ${commit.author ?? identity}`);
  lines.push(`committer ${commit.committer ?? identity}`);
  lines.push('');
  // The message is stored verbatim (no forced trailing newline): REST reads it back exactly.
  return Buffer.from(`${lines.join('\n')}\n${commit.message}`, 'utf8');
}

/** Create a server commit (contents PUT/DELETE, squash merge) and store it. */
export function createServerCommit(parent: string | null, tree: string, message: string): string {
  const data = buildCommit({ tree, parents: parent === null ? [] : [parent], message });
  return putObject('commit', data);
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPE_IDS: Readonly<Record<GitObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

const PACK_TYPE_NAMES: Readonly<Record<number, GitObjectType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

function readSizeVarint(buf: Buffer, offset: number, firstLowBits: number, firstBits: number): { value: number; next: number } {
  let value = firstLowBits;
  let shift = firstBits;
  let at = offset;
  for (;;) {
    if (at >= buf.length) throw new Error('truncated pack varint');
    const byte = buf[at] as number;
    at += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

/** Apply a git delta to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} does not match base ${base.length}`);
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset] as number;
    offset += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('truncated delta copy offset');
          copyOffset |= (delta[offset] as number) << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('truncated delta copy size');
          copySize |= (delta[offset] as number) << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      if (offset + opcode > delta.length) throw new Error('truncated delta insert');
      chunks.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (produced !== targetSize) throw new Error(`delta produced ${produced} bytes, expected ${targetSize}`);
  return Buffer.concat(chunks);
}

interface PackEntryRaw {
  offset: number;
  type: number;
  size: number;
  /** For ofs-delta: the base entry's offset. For ref-delta: the base oid. */
  baseOffset?: number;
  baseOid?: string;
  /** The inflated entry data (the object bytes, or the delta bytes for delta entries). */
  data: Buffer;
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/**
 * Parse a packfile into its objects (deltas resolved, thin-pack bases read from the store).
 * Throws on any malformation, including a trailer checksum mismatch.
 */
export function parsePack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack magic is not PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack version ${version} is not 2`);
  const count = pack.readUInt32BE(8);
  // Verify the trailer (SHA-1 of everything before it).
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1Hex(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack trailer checksum mismatch');

  const entries: PackEntryRaw[] = [];
  let offset = 12;
  const body = pack.subarray(0, trailerStart);
  for (let index = 0; index < count; index += 1) {
    if (offset >= trailerStart) throw new Error('pack ends before its declared object count');
    const entryOffset = offset;
    const first = pack[offset] as number;
    offset += 1;
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    if ((first & 0x80) !== 0) {
      const rest = readSizeVarint(pack, offset, size, 4);
      size = rest.value;
      offset = rest.next;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      // ofs-delta: the base offset, stored as a negative offset varint.
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      let byte = pack[offset] as number;
      offset += 1;
      let base = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= trailerStart) throw new Error('truncated ofs-delta base offset');
        byte = pack[offset] as number;
        offset += 1;
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - base;
      if (baseOffset < 0 || baseOffset >= entryOffset) throw new Error('ofs-delta base offset out of range');
    } else if (type === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta has no base oid');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (PACK_TYPE_NAMES[type] === undefined) {
      throw new Error(`unknown pack entry type ${type}`);
    }
    const inflated = inflateAt(body, offset);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entries.push({ offset: entryOffset, type, size, baseOffset, baseOid, data: inflated.data });
    offset = inflated.next;
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const byOffset = new Map<number, PackEntryRaw>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolvedByOffset = new Map<number, GitObject>();
  const resolvedByOid = new Map<string, GitObject>();
  const resolving = new Set<number>();

  const resolve = (entry: PackEntryRaw): GitObject => {
    const memoized = resolvedByOffset.get(entry.offset);
    if (memoized !== undefined) return memoized;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let object: GitObject;
    if (entry.type === 6 || entry.type === 7) {
      let base: GitObject | null = null;
      if (entry.type === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseEntry);
      } else {
        const baseOid = entry.baseOid as string;
        const inPack = resolvedByOid.get(baseOid);
        if (inPack !== undefined) base = inPack;
        else base = getObject(baseOid);
        if (base === null) throw new Error(`ref-delta base ${baseOid} is neither in the pack nor in the store`);
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const type = PACK_TYPE_NAMES[entry.type] as GitObjectType;
      object = { type, data: entry.data };
    }
    resolving.delete(entry.offset);
    resolvedByOffset.set(entry.offset, object);
    resolvedByOid.set(hashObject(object.type, object.data), object);
    return object;
  };

  const out = new Map<string, GitObject>();
  for (const entry of entries) {
    const object = resolve(entry);
    out.set(hashObject(object.type, object.data), object);
  }
  return out;
}
/** Build a packfile (v2, plain objects, no deltas) for the given oids, in deterministic order. */
export function buildPack(oids: readonly string[]): Buffer {
  const sorted = [...oids].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const oid of sorted) {
    const object = objects.get(oid);
    if (object === undefined) throw new Error(`pack build: object ${oid} is not in the store`);
    const typeId = PACK_TYPE_IDS[object.type];
    const size = object.data.length;
    const headerBytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- ancestry

/** All commits reachable from `oid` (including it), stopping descent at `stopAt` members. */
export function commitAncestors(oid: string, stopAt: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (stopAt.has(current)) continue;
    const commit = getCommit(current);
    if (commit === null) continue;
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const stack: string[] = [descendant];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = getCommit(current);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** A merge-base of `a` and `b` (the nearest common ancestor; exact for linear histories). */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsA = commitAncestors(a);
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (ancestorsA.has(current)) return current;
    const commit = getCommit(current);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/** Commits reachable from `tip`, newest first (depth-first pre-order, deduplicated). */
export function commitList(tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = getCommit(current);
    if (commit === null) continue;
    out.push(current);
    for (let index = commit.parents.length - 1; index >= 0; index -= 1) {
      stack.push(commit.parents[index] as string);
    }
  }
  return out;
}

// ---------------------------------------------------------------- trees

export interface FlatEntry {
  mode: string;
  oid: string;
}

const flatCache = new Map<string, Map<string, FlatEntry>>();

/** A tree flattened to path -> {mode, oid}, recursively (cached; trees are immutable). */
export function flattenTree(treeOid: string): Map<string, FlatEntry> {
  const cached = flatCache.get(treeOid);
  if (cached !== undefined) return cached;
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const entries = getTree(oid);
    if (entries === null) return;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  flatCache.set(treeOid, out);
  return out;
}

/** The flat file map of a commit's tree (empty when the commit has no readable tree). */
export function flattenCommit(commitOid: string): Map<string, FlatEntry> {
  const commit = getCommit(commitOid);
  if (commit === null) return new Map();
  return flattenTree(commit.tree);
}

/** Look up one path in a tree (null when absent). */
export function treeLookup(treeOid: string, segments: readonly string[]): { mode: string; oid: string } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const entries = getTree(current);
    if (entries === null) return null;
    const entry = entries.find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * A tree with `segments` set to `blobOid` (or removed when null), every other entry kept.
 * Returns the new tree's oid. Intermediate trees are created as needed; emptied trees are pruned.
 */
export function treeWithPath(treeOid: string | null, segments: readonly string[], blobOid: string | null, mode = '100644'): string {
  const head = segments[0] as string;
  const rest = segments.slice(1);
  const entries = treeOid === null ? [] : (getTree(treeOid) ?? []);
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) kept.push({ mode, name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const child = treeWithPath(existing?.oid ?? null, rest, blobOid, mode);
    const childEntries = getTree(child) ?? [];
    if (childEntries.length > 0) kept.push({ mode: '40000', name: head, oid: child });
  }
  return putObject('tree', buildTree(kept));
}

// ---------------------------------------------------------------- diffs

export interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

/** The path-level diff between two trees (base -> head), sorted by path. */
export function diffTrees(baseTree: string | null, headTree: string | null): DiffEntry[] {
  const base = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(baseTree);
  const head = headTree === null ? new Map<string, FlatEntry>() : flattenTree(headTree);
  const out: DiffEntry[] = [];
  for (const [path, entry] of head) {
    const before = base.get(path);
    if (before === undefined) out.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
    else if (before.oid !== entry.oid || before.mode !== entry.mode) {
      out.push({ path, status: 'modified', oldOid: before.oid, newOid: entry.oid });
    }
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) out.push({ path, status: 'removed', oldOid: entry.oid, newOid: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Added/removed line counts between two blob versions (common prefix/suffix lines factored out). */
export function diffLineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null && newData === null) return { additions: 0, deletions: 0 };
  if (oldData === null) return { additions: countLines(newData as Buffer), deletions: 0 };
  if (newData === null) return { additions: 0, deletions: countLines(oldData) };
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

// ---------------------------------------------------------------- pack closure

/**
 * The object closure of a set of commits: the commits themselves plus every tree and blob their
 * trees hold (parents NOT included). `stopAt` commits contribute their own closure but their
 * parents are not walked (they are not part of this closure anyway).
 */
export function objectClosureOfCommits(commits: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const oid of commits) {
    const commit = getCommit(oid);
    if (commit === null) continue;
    out.add(oid);
    const stack: string[] = [commit.tree];
    while (stack.length > 0) {
      const treeOid = stack.pop() as string;
      if (out.has(treeOid)) continue;
      out.add(treeOid);
      const entries = getTree(treeOid);
      if (entries === null) continue;
      for (const entry of entries) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else out.add(entry.oid);
      }
    }
  }
  return out;
}
