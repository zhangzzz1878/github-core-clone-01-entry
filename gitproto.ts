// gitproto.ts — git smart-HTTP (protocol v2 + v0) for the forge.
// Hand-written for the github-core-clone-01 bounty entry. Node built-ins only.

import {
  ZERO_OID, DEFAULT_BRANCH,
  type Repo, type GitObject,
  hashObject, parseCommit, parseTree, parseTag, buildPack, parsePack,
  collectReachable, isAncestor,
} from './store.ts';

export const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const out = Buffer.alloc(len);
  out.write(len.toString(16).padStart(4, '0'), 0, 'latin1');
  body.copy(out, 4);
  return out;
}

export const FLUSH_PKT = Buffer.from('0000', 'latin1');
export const DELIM_PKT = Buffer.from('0001', 'latin1');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('latin1');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// Split a request body into pkt-line lines (before the first flush) and the
// trailing raw bytes (the pack section of a receive-pack / fetch body).
export function splitPktBody(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('latin1');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len === 0) { off += 4; break; }
    if (len === 1) { off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    lines.push(buf.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  return { lines, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function defaultTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
}

function peeledCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const t = parseTag(obj.data);
  const target = repo.objects.get(t.object);
  if (!target) return null;
  if (target.type === 'commit') return t.object;
  if (target.type === 'tag') return peeledCommit(repo, t.object);
  return null;
}

const UPLOAD_V0_CAPS = 'side-band-64k ofs-delta thin-pack multi_ack shallow symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

// v0 advertisement: "# service=..." preamble, flush, ref lines, flush.
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = defaultTip(repo) ?? ZERO_OID;
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// v2 advertisement (upload-pack only): preamble, flush, "version 2", caps, flush.
export function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    FLUSH_PKT,
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH_PKT,
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { lines } = splitPktBody(body);
  const prefixes: string[] = [];
  let wantUnborn = false;
  for (const line of lines) {
    const trimmed = line.replace(/\n$/, '');
    if (trimmed.startsWith('ref-prefix ')) prefixes.push(trimmed.slice('ref-prefix '.length));
    else if (trimmed === 'unborn') wantUnborn = true;
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const tip = defaultTip(repo);
  // HEAD first (zero oid when unborn), then refs sorted. No unborn refs/ lines
  // for a completely empty repo: the conformance contract requires a fresh
  // repository to advertise zero refs/ names.
  if (keep('HEAD')) {
    parts.push(pktLine(`${tip ?? ZERO_OID} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const peeled = peeledCommit(repo, ref.oid);
    if (peeled) line += ` peeled:${peeled}`;
    parts.push(pktLine(line + '\n'));
  }
  if (wantUnborn && !tip && repo.refs.size > 0) {
    const name = `refs/heads/${DEFAULT_BRANCH}`;
    if (keep(name)) parts.push(pktLine(`unborn ${name}\n`));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  sendObjects: Set<string>;
  boundary: string[];
  unshallow: string[];
}

// BFS from roots, counting generations (wants are generation 1). With a depth
// limit, commits at exactly `depth` generations are the new shallow boundary
// and their parents are not walked.
function depthLimitedWalk(repo: Repo, roots: string[], depth: number | null): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<[string, number]> = roots.map((r) => [r, 1] as [string, number]);
  let head = 0;
  while (head < queue.length) {
    const [oid, gen] = queue[head++];
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    included.add(oid);
    if (depth !== null && gen >= depth) { boundary.add(oid); continue; }
    for (const p of parseCommit(obj.data).parents) queue.push([p, gen + 1]);
  }
  return { included, boundary };
}

// Full object closure of a commit set plus extra roots (tags): commits, their
// trees, sub-trees, blobs, and tag targets.
function expandClosure(repo: Repo, commitOids: Iterable<string>, extraRoots: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const expand = (oid: string): void => {
    if (!oid || seen.has(oid)) return;
    seen.add(oid);
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
  for (const oid of commitOids) expand(oid);
  for (const oid of extraRoots) expand(oid);
  return out;
}

// Peel a tag oid down to its commit target (or the oid itself).
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

function planFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, clientShallow: string[]): FetchPlan {
  const wantCommits: string[] = [];
  const extraRoots: string[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extraRoots.push(w);
      wantCommits.push(peelToCommit(repo, w));
    } else if (obj.type === 'commit') {
      wantCommits.push(w);
    }
  }
  const { included, boundary } = depthLimitedWalk(repo, wantCommits, depth);
  const stopAt = new Set(clientShallow);
  const haveCommits = new Set<string>();
  const haveRoots: string[] = [];
  for (const h of haves) {
    const obj = repo.objects.get(h);
    if (!obj) continue;
    if (obj.type === 'tag') haveRoots.push(h);
    else if (obj.type === 'commit') haveCommits.add(h);
  }
  // Reachable-from-haves commits, stopping ancestry expansion at the
  // client's shallow boundaries (their parents are not held).
  const heldCommits = new Set<string>();
  {
    const seen = new Set<string>();
    const stack = [...haveCommits];
    while (stack.length) {
      const oid = stack.pop()!;
      if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      heldCommits.add(oid);
      if (stopAt.has(oid)) continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
  }
  const sendCommits = new Set<string>();
  for (const c of included) if (!heldCommits.has(c)) sendCommits.add(c);
  const wantObjects = expandClosure(repo, included, extraRoots);
  const haveObjects = expandClosure(repo, heldCommits, haveRoots);
  const sendObjects = new Set<string>();
  for (const o of wantObjects) if (!haveObjects.has(o)) sendObjects.add(o);
  const unshallow = clientShallow.filter((s) => included.has(s) && !boundary.has(s));
  return { sendObjects, boundary: [...boundary], unshallow };
}

function packForObjects(repo: Repo, oids: Set<string>): Buffer {
  const objects: GitObject[] = [];
  for (const oid of [...oids].sort()) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return buildPack(objects);
}

// Sideband framing: band byte 1 + payload chunks. A pkt-line is at most
// 65520 bytes total (4-byte length header included), so each chunk is at
// most 65515 bytes of pack data plus the 1 band byte.
function sideband(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  if (data.length === 0) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return out;
  }
  for (let off = 0; off < data.length; off += 65515) {
    const chunk = data.subarray(off, Math.min(off + 65515, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// v2 fetch / v0 fetch
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchRequest(lines: string[], v0: boolean): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const oid = rest.split(' ')[0];
      if (oid) req.wants.push(oid);
    } else if (line.startsWith('have ')) {
      req.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      req.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (!Number.isNaN(n)) req.depth = n;
    }
    // command=, agent=, object-format=, thin-pack, no-progress, ofs-delta,
    // filter, done and capability lines are accepted and ignored.
  }
  return req;
}

export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const { lines } = splitPktBody(body);
  const req = parseFetchRequest(lines, false);
  const cacheKey = `v2:${req.wants.join(',')}|${req.haves.join(',')}|${req.depth ?? ''}|${req.shallow.join(',')}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached) return cached;
  const plan = planFetch(repo, req.wants, req.haves, req.depth, req.shallow);
  const pack = packForObjects(repo, plan.sendObjects);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH_PKT];
  if (req.depth !== null || req.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const b of plan.boundary) parts.push(pktLine(`shallow ${b}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(FLUSH_PKT);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sideband(pack));
  parts.push(FLUSH_PKT);
  const out = Buffer.concat(parts);
  repo.packCache.set(cacheKey, out);
  return out;
}

export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const { lines } = splitPktBody(body);
  const req = parseFetchRequest(lines, true);
  const cacheKey = `v0:${req.wants.join(',')}|${req.haves.join(',')}|${req.depth ?? ''}|${req.shallow.join(',')}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached) return cached;
  const plan = planFetch(repo, req.wants, req.haves, req.depth, req.shallow);
  const pack = packForObjects(repo, plan.sendObjects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const b of plan.boundary) parts.push(pktLine(`shallow ${b}\n`));
  for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(...sideband(pack));
  parts.push(FLUSH_PKT);
  const out = Buffer.concat(parts);
  repo.packCache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): { body: Buffer; changed: boolean } {
  const { lines, rest } = splitPktBody(body);
  const commands: PushCommand[] = [];
  let wantSideband = true;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\n$/, '');
    if (!raw) continue;
    const nul = raw.indexOf('\0');
    const head = nul === -1 ? raw : raw.slice(0, nul);
    const caps = nul === -1 ? '' : raw.slice(nul + 1);
    if (i === 0 && caps) wantSideband = caps.split(' ').includes('side-band-64k');
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const parsed = parsePack(rest, repo.objects);
      for (const [oid, obj] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpacker error';
    }
  }

  let changed = false;
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let ok = false;
      let reason = '';
      if (!cmd.ref.startsWith('refs/')) {
        reason = 'invalid ref name';
      } else if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reason = 'reference does not exist';
        else if (current !== cmd.oldOid) reason = 'old value mismatch';
        else { ok = true; }
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) reason = 'already exists';
        else if (!repo.objects.has(cmd.newOid)) reason = 'missing object';
        else { ok = true; }
      } else {
        // Update.
        if (current === undefined) reason = 'reference does not exist';
        else if (current !== cmd.oldOid) reason = 'old value mismatch';
        else if (!repo.objects.has(cmd.newOid)) reason = 'missing object';
        else if (cmd.newOid === cmd.oldOid) ok = true;
        else {
          const newObj = repo.objects.get(cmd.newOid)!;
          if (newObj.type === 'commit') {
            if (isAncestor(repo, cmd.oldOid, cmd.newOid)) ok = true;
            else reason = 'non-fast-forward';
          } else {
            ok = true; // tag / other object updates are not FF-checked
          }
        }
      }
      if (ok) {
        if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
        else repo.refs.set(cmd.ref, cmd.newOid);
        changed = true;
        reportLines.push(`ok ${cmd.ref}\n`);
      } else {
        reportLines.push(`ng ${cmd.ref} ${reason}\n`);
      }
    }
  } else {
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpacker error\n`);
  }

  if (changed) repo.packCache.clear();
  const reportBody = Buffer.concat([
    pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`),
    ...reportLines.map((l) => pktLine(l)),
  ]);
  let out: Buffer;
  if (wantSideband) {
    out = Buffer.concat([...sideband(reportBody), FLUSH_PKT]);
  } else {
    out = Buffer.concat([reportBody, FLUSH_PKT]);
  }
  return { body: out, changed };
}
