// store.ts — in-memory data model + git object layer for the forge.
// Hand-written for the github-core-clone-01 bounty entry. Node built-ins only.
// Determinism: no wall-clock, no randomness anywhere in this module.
// Commit timestamps for API-created commits use a fixed base epoch plus a
// per-repo counter, so identical request sequences produce identical bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const FIXED_TS = '2026-01-01T00:00:00Z';
export const COMMIT_EPOCH_BASE = 1700000000;

// ---------------------------------------------------------------------------
// Git object model
// ---------------------------------------------------------------------------

export interface GitObject {
  type: string; // 'commit' | 'tree' | 'blob' | 'tag'
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'latin1');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isObjectId(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string; // raw "Name <email> epoch tz"
  committer: string;
  message: string; // without trailing newline
  rawMessage: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const rawMessage = split === -1 ? '' : text.slice(split + 2);
  const out: ParsedCommit = {
    tree: '', parents: [], author: '', committer: '',
    message: rawMessage.replace(/\n+$/, ''), rawMessage,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export interface TreeEntry {
  mode: string; // '100644' | '40000' | '100755' | '120000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const mode = data.subarray(off, sp).toString('latin1');
    const nul = data.indexOf(0, sp + 1);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return Buffer.compare(Buffer.from(an, 'utf8'), Buffer.from(bn, 'utf8'));
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const out: ParsedTag = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2).replace(/\n+$/, '') };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pack codec (plain objects only on write; deltas resolved on read)
// ---------------------------------------------------------------------------

const PACK_TYPE = { commit: 1, tree: 2, blob: 3, tag: 4, ofsDelta: 6, refDelta: 7 } as const;
const PACK_TYPE_NAME: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// Read a type/size varint. Returns [type, size, nextOffset].
function readVarint(buf: Buffer, off: number): [number, number, number] {
  let byte = buf[off];
  let type = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (byte & 0x80) {
    byte = buf[i++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return [type, size, i];
}

function writeVarint(type: number, size: number): Buffer {
  const out: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    out.push(byte | 0x80);
    byte = size & 0x7f;
    size >>= 7;
  }
  out.push(byte);
  return Buffer.from(out);
}

export function buildPack(objects: { type: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = (PACK_TYPE as Record<string, number>)[obj.type] ?? 3;
    parts.push(writeVarint(typeCode, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Delta application (git delta format).
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint7 = (): number => {
    let result = 0;
    let shift = 0;
    while (true) {
      const b = delta[off++];
      result |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return result;
  };
  const srcSize = readVarint7();
  const dstSize = readVarint7();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize |= delta[off++] << 8;
      if (op & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      const chunk = base.subarray(cpOff, cpOff + cpSize);
      chunks.push(chunk);
      total += chunk.length;
    } else if (op > 0) {
      const chunk = delta.subarray(off, off + op);
      chunks.push(chunk);
      total += chunk.length;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== dstSize) throw new Error('delta result size mismatch');
  return Buffer.concat(chunks);
}

export interface ParsedPack {
  objects: Map<string, GitObject>; // oid -> object (hash verified)
}

// Parse a pack buffer. `external` lets thin packs resolve bases held in the
// repo. Throws on malformed input.
export function parsePack(buf: Buffer, external?: Map<string, GitObject>): ParsedPack {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('bad pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expectTrailer = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expectTrailer)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    type: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, number>(); // offset -> entry index
  let off = 12;
  for (let i = 0; i < count; i++) {
    const start = off;
    const [type, _size, afterVarint] = readVarint(buf, off);
    off = afterVarint;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      // ofs-delta: negative offset varint
      let byte = buf[off++];
      let base = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[off++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - base;
    } else if (type === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateSync(buf.subarray(off), { info: true } as unknown as { info: boolean }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = inflated.buffer as Buffer;
    const consumed = (inflated as unknown as { engine: { bytesWritten: number } }).engine.bytesWritten;
    entries.push({ type, data, baseOffset, baseOid });
    byOffset.set(start, entries.length - 1);
    off += consumed;
  }

  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, GitObject>();
  // Precompute oids of plain entries so ref-delta bases can be found even
  // when the base entry appears later in the pack.
  const plainOidToIndex = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 6 && e.type !== 7) {
      plainOidToIndex.set(hashObject(PACK_TYPE_NAME[e.type] ?? 'blob', e.data), i);
    }
  }
  const resolve = (idx: number): GitObject => {
    const cached = resolved.get(idx);
    if (cached) return cached;
    const entry = entries[idx];
    let result: GitObject;
    if (entry.type === 6 || entry.type === 7) {
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseIdx = byOffset.get(entry.baseOffset);
        if (baseIdx === undefined) throw new Error('delta base offset not found');
        base = resolve(baseIdx);
      } else if (entry.baseOid !== undefined) {
        const baseIdx = plainOidToIndex.get(entry.baseOid);
        if (baseIdx !== undefined) base = resolve(baseIdx);
        else base = external?.get(entry.baseOid) ?? objects.get(entry.baseOid);
        if (!base) throw new Error('delta base object not found');
      }
      if (!base) throw new Error('delta without base');
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data };
    } else {
      result = { type: PACK_TYPE_NAME[entry.type] ?? 'blob', data: entry.data };
    }
    resolved.set(idx, result);
    objects.set(hashObject(result.type, result.data), result);
    return result;
  };
  for (let i = 0; i < entries.length; i++) resolve(i);
  return { objects };
}

// ---------------------------------------------------------------------------
// Shared API response shape (REST / GraphQL / MCP / git handlers)
// ---------------------------------------------------------------------------

export interface ApiResult {
  status: number;
  headers?: Record<string, string>;
  json?: unknown; // send as JSON
  raw?: Buffer; // send as-is
  contentType?: string; // for raw bodies
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number; // creation order within the repo
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number; // databaseId, stable
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number; // creation order
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // refname -> oid
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextIssueNumber: number; // shared with PRs (GitHub numbering)
  nextCommentId: number;
  nextLabelId: number;
  commitSeq: number; // for deterministic REST-commit timestamps
  packCache: Map<string, Buffer>;
  issueJsonCache: Map<number, Buffer>; // serialized single-issue GET bodies
}

export interface Store {
  repos: Map<string, Repo>; // "owner/name" -> Repo
  repoList: Repo[]; // creation order
  nextRepoId: number;
  nextIssueId: number;
  nextPullId: number;
  nextCommentGlobalId: number;
  requestSeq: number;
}

export function createStore(): Store {
  return {
    repos: new Map(),
    repoList: [],
    nextRepoId: 1,
    nextIssueId: 1,
    nextPullId: 1,
    nextCommentGlobalId: 1,
    requestSeq: 0,
  };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined; // any other owner -> 404, never 403
  return store.repos.get(repoKey(owner, name));
}

export function createRepo(store: Store, name: string, opts: { description?: string; private?: boolean }): Repo {
  const repo: Repo = {
    id: store.nextRepoId++,
    name,
    owner: VIEWER_LOGIN,
    description: opts.description ?? '',
    private: opts.private ?? false,
    defaultBranch: DEFAULT_BRANCH,
    seq: store.repoList.length,
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextIssueNumber: 1,
    nextCommentId: 1,
    nextLabelId: 1,
    commitSeq: 0,
    packCache: new Map(),
    issueJsonCache: new Map(),
  };
  store.repos.set(repoKey(VIEWER_LOGIN, name), repo);
  store.repoList.push(repo);
  return repo;
}

export function deleteRepo(store: Store, repo: Repo): void {
  store.repos.delete(repoKey(repo.owner, repo.name));
  const idx = store.repoList.indexOf(repo);
  if (idx !== -1) store.repoList.splice(idx, 1);
}

// ---------------------------------------------------------------------------
// Git operations on a repo
// ---------------------------------------------------------------------------

export function storeObject(repo: Repo, type: string, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export function getBranchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(branchRef(branch));
}

// Walk commit ancestry (all parents, visited set). Calls visit(oid) for every
// commit reached, starting at `roots`. Stops expanding at `stopAt` oids
// (shallow boundaries) — their parents are not held.
export function walkCommits(repo: Repo, roots: string[], stopAt: Set<string>, visit: (oid: string) => void): void {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    visit(oid);
    if (stopAt.has(oid)) continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
}

// All objects reachable from `roots` (commits + their trees/blobs/tags),
// stopping ancestry expansion at `stopAt` commits.
export function collectReachable(repo: Repo, roots: string[], stopAt: Set<string>): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [];
  walkCommits(repo, roots, stopAt, (oid) => {
    out.add(oid);
    queue.push(oid);
  });
  // Expand trees/blobs from the visited commits (and any tag roots).
  const seenObj = new Set<string>();
  const expand = (oid: string) => {
    if (seenObj.has(oid)) return;
    seenObj.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) return;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) expand(c.tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) expand(e.oid);
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object) expand(t.object);
    }
  };
  for (const oid of roots) {
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') expand(oid);
  }
  for (const oid of queue) {
    const c = parseCommit(repo.objects.get(oid)!.data);
    if (c.tree) expand(c.tree);
  }
  return out;
}

// True when `ancestor` is reachable from `descendant` (inclusive).
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  let found = false;
  walkCommits(repo, [descendant], new Set(), (oid) => {
    if (oid === ancestor) found = true;
  });
  return found;
}

// Merge-base: the first common ancestor found by walking both sides
// generation by generation (BFS from both tips).
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const seenA = new Set<string>([a]);
  const seenB = new Set<string>([b]);
  const queueA = [a];
  const queueB = [b];
  // Interleave BFS expansion; the first commit seen on both sides wins.
  let ia = 0;
  let ib = 0;
  while (ia < queueA.length || ib < queueB.length) {
    if (ia < queueA.length) {
      const cur = queueA[ia++];
      const obj = repo.objects.get(cur);
      if (obj && obj.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) {
          if (seenB.has(p)) return p;
          if (!seenA.has(p)) { seenA.add(p); queueA.push(p); }
        }
      }
    }
    if (ib < queueB.length) {
      const cur = queueB[ib++];
      const obj = repo.objects.get(cur);
      if (obj && obj.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) {
          if (seenA.has(p)) return p;
          if (!seenB.has(p)) { seenB.add(p); queueB.push(p); }
        }
      }
    }
  }
  return null;
}

// Flatten a tree (recursively) to path -> blob oid.
export function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, e.oid);
  }
}

// Set or remove a path in a tree, returning the new root tree oid.
// `newBlobOid` null removes the path. Creates intermediate trees as needed.
export function updateTreePath(repo: Repo, rootTreeOid: string | null, segments: string[], newBlobOid: string | null): string {
  const recurse = (treeOid: string | null, depth: number): string => {
    const entries: TreeEntry[] = treeOid ? parseTree(repo.objects.get(treeOid)!.data) : [];
    const seg = segments[depth];
    const isLast = depth === segments.length - 1;
    const idx = entries.findIndex((e) => e.name === seg);
    if (isLast) {
      if (newBlobOid === null) {
        if (idx !== -1) entries.splice(idx, 1);
      } else if (idx !== -1) {
        entries[idx] = { mode: '100644', name: seg, oid: newBlobOid };
      } else {
        entries.push({ mode: '100644', name: seg, oid: newBlobOid });
      }
    } else {
      let childOid: string | null = null;
      if (idx !== -1 && entries[idx].mode === '40000') childOid = entries[idx].oid;
      const newChild = recurse(childOid, depth + 1);
      if (idx !== -1) entries[idx] = { mode: '40000', name: seg, oid: newChild };
      else entries.push({ mode: '40000', name: seg, oid: newChild });
    }
    return storeObject(repo, 'tree', buildTreeBytes(entries));
  };
  return recurse(rootTreeOid, 0);
}

// Read a blob oid at a path in a tree, or null. Also reports whether the path
// is a directory.
export function lookupPath(repo: Repo, treeOid: string | null, segments: string[]): { kind: 'file' | 'dir'; oid: string } | null {
  let cur: string | null = treeOid;
  for (let i = 0; i < segments.length; i++) {
    if (!cur) return null;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const e = parseTree(obj.data).find((x) => x.name === segments[i]);
    if (!e) return null;
    if (i === segments.length - 1) {
      return e.mode === '40000' ? { kind: 'dir', oid: e.oid } : { kind: 'file', oid: e.oid };
    }
    if (e.mode !== '40000') return null;
    cur = e.oid;
  }
  return null;
}

export function listTreeDir(repo: Repo, treeOid: string | null): TreeEntry[] {
  if (!treeOid) return [];
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

// Create a commit on a branch (REST contents / merge). Deterministic
// author/committer identity and timestamp.
export function makeApiCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const ts = COMMIT_EPOCH_BASE + repo.commitSeq++;
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const msg = message.endsWith('\n') ? message : message + '\n';
  let text = `tree ${treeOid}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${who}\ncommitter ${who}\n\n${msg}`;
  return storeObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

// ---------------------------------------------------------------------------
// Issues / labels / comments / pulls
// ---------------------------------------------------------------------------

export function createIssue(store: Store, repo: Repo, title: string, body: string, labelNames: string[]): Issue {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (label) labels.push(label);
  }
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextIssueNumber++,
    title,
    body,
    state: 'open',
    labels,
    seq: repo.nextIssueNumber,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createLabel(repo: Repo, name: string, color: string, description?: string): Label {
  const label: Label = { id: repo.nextLabelId++, name, color, description: description ?? '' };
  repo.labels.set(name, label);
  return label;
}

export function createComment(store: Store, repo: Repo, issue: Issue, body: string): Comment {
  const comment: Comment = { id: store.nextCommentGlobalId++, body, seq: repo.nextCommentId++ };
  issue.comments.push(comment);
  repo.issueJsonCache.delete(issue.number); // the comments count changed
  return comment;
}

export function createPull(store: Store, repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
  const headSha = getBranchTip(repo, headRef);
  const baseSha = getBranchTip(repo, baseRef);
  if (!headSha || !baseSha) return null;
  const pull: Pull = {
    id: store.nextPullId++,
    number: repo.nextIssueNumber++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    headSha,
    baseRef,
    baseSha,
    seq: repo.nextIssueNumber,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

// Diff between two trees: path -> {status, oldOid, newOid}
export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = new Map<string, string>();
  const head = new Map<string, string>();
  if (baseTreeOid) flattenTree(repo, baseTreeOid, '', base);
  if (headTreeOid) flattenTree(repo, headTreeOid, '', head);
  const out: FileChange[] = [];
  for (const [path, oid] of head) {
    if (!base.has(path)) out.push({ path, status: 'added', oldOid: null, newOid: oid });
    else if (base.get(path) !== oid) out.push({ path, status: 'modified', oldOid: base.get(path)!, newOid: oid });
  }
  for (const [path, oid] of base) {
    if (!head.has(path)) out.push({ path, status: 'removed', oldOid: oid, newOid: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

export function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

// Conflict rule (shared by REST merge and GraphQL mergeable):
// a file changed head-vs-merge-base where base-tip content != merge-base
// content AND head content != merge-base content AND head != base-tip.
export function computeMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTip = getBranchTip(repo, pull.headRef);
  const baseTip = getBranchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const base = mergeBase(repo, headTip, baseTip);
  if (!base) return 'UNKNOWN';
  const baseTree = treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headTip);
  const tipTree = treeOfCommit(repo, baseTip);
  const baseFlat = new Map<string, string>();
  const headFlat = new Map<string, string>();
  const tipFlat = new Map<string, string>();
  if (baseTree) flattenTree(repo, baseTree, '', baseFlat);
  if (headTree) flattenTree(repo, headTree, '', headFlat);
  if (tipTree) flattenTree(repo, tipTree, '', tipFlat);
  for (const [path, headOid] of headFlat) {
    const baseOid = baseFlat.get(path) ?? null;
    if (baseOid === headOid) continue; // unchanged vs merge-base
    const tipOid = tipFlat.get(path) ?? null;
    if (tipOid === baseOid) continue; // base tip unchanged -> clean
    if (tipOid === headOid) continue; // same change -> clean
    return 'CONFLICTING';
  }
  // Deletions on head vs merge-base also conflict the same way.
  for (const [path, baseOid] of baseFlat) {
    if (headFlat.has(path)) continue;
    const tipOid = tipFlat.get(path) ?? null;
    if (tipOid === baseOid) continue;
    if (tipOid === null) continue; // deleted on both sides
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// Squash-merge a pull onto its base branch. Returns the merge commit oid, or
// null when the PR cannot be merged (conflicted / already closed / missing).
export function squashMergePull(store: Store, repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open') return null;
  if (computeMergeable(repo, pull) === 'CONFLICTING') return null;
  const headTip = getBranchTip(repo, pull.headRef);
  const baseTip = getBranchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return null;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base ? treeOfCommit(repo, base) : null;
  const headTree = treeOfCommit(repo, headTip);
  const tipTree = treeOfCommit(repo, baseTip);
  // Apply the head-vs-merge-base diff onto the base tip tree.
  let newTree = tipTree;
  const changes = diffTrees(repo, baseTree, headTree);
  for (const ch of changes) {
    newTree = updateTreePath(repo, newTree, ch.path.split('/'), ch.newOid);
  }
  const msg = `Squash merge #${pull.number}: ${pull.title}`;
  const mergeSha = makeApiCommit(repo, newTree, [baseTip], msg);
  repo.refs.set(branchRef(pull.baseRef), mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TS;
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  repo.packCache.clear();
  return mergeSha;
}

// ---------------------------------------------------------------------------
// JSON serializers (GitHub-flavoured shapes used by REST / MCP / GraphQL)
// ---------------------------------------------------------------------------

export function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', html_url: `https://github.com/${login}`, url: `https://api.github.com/users/${login}` };
}

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER_ID),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    pushed_at: FIXED_TS,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.id, node_id: globalId('Label', repo.id, l.id), name: l.name, color: l.color, description: l.description, default: false })),
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    assignee: null,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: issue.state === 'closed' ? FIXED_TS : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', repo.id, label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: pull.state === 'closed' ? FIXED_TS : null,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: userJson(VIEWER_LOGIN, VIEWER_ID) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: userJson(VIEWER_LOGIN, VIEWER_ID) },
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const parsed = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const message = parsed ? parsed.message : '';
  const authorLine = parsed?.author ?? '';
  const committerLine = parsed?.committer ?? '';
  const parseWho = (line: string): { name: string; email: string; date: string } => {
    const m = line.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
    if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TS };
    const date = new Date(Number(m[3]) * 1000).toISOString();
    return { name: m[1], email: m[2], date };
  };
  const author = parseWho(authorLine);
  const committer = parseWho(committerLine);
  return {
    sha: oid,
    commit: {
      message,
      author,
      committer,
      tree: { sha: parsed?.tree ?? '' },
    },
    author: userJson(VIEWER_LOGIN, VIEWER_ID),
    committer: userJson(VIEWER_LOGIN, VIEWER_ID),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}
