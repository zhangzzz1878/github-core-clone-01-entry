# HANDOFF — github-core-clone-01 (GitHub-compatible git forge)

## Final local scores (kit runner, fresh server each run)

| Run | Checks | MCP | Feature | Agent | Perf | Total |
|-----|--------|-----|---------|-------|------|-------|
| run2 (no --perf) | 120/120 | 15/15 | 600 | 200 | — | 800 |
| run4 (--perf) | 120/120 | 15/15 | 600 | 200 | 176 | **976** |
| run5 (--perf) | 120/120 | 15/15 | 600 | 200 | 179 | **979** |

Perf breakdown (run5): push 44 (p50 584 ms), clone 36 (p50 146 ms),
read 50 (p50 655 ms), write 49 (p50 92 ms). The ~958 prize line from the
top-entries analysis is beaten by both perf runs.

How the runs were done (reproducible): start the entry with
`MAKEFUN_SHOP_TOKEN=test` on an ephemeral port, then from the kit dir run
`~/workspace/makefun/node22/bin/node --experimental-strip-types sdk/run.ts
--url http://127.0.0.1:PORT --token test --perf --json`. **Important:** each
run needs a freshly started server — re-running against a server that already
holds state makes repo creation return 422 "already exists" and most checks
fail for that reason alone (seen in run3; not a server bug).

## How to start

```sh
node --experimental-strip-types main.ts
```

- Node 22 (`~/workspace/makefun/node22/bin/node` locally; system node is v24,
  do not use it for testing). Node built-ins only, no packages.
- `main.ts` is the kit starter lifecycle, kept verbatim: `listen(0)` →
  POST `{"port": N}` to `$MAKEFUN_ENV_URL/register` → poll
  `$MAKEFUN_ENV_URL/done` → exit 0. Without `MAKEFUN_ENV_URL` it exits 1
  (verified). With a stub env, register + done + exit 0 verified.
- `MAKEFUN_SHOP_TOKEN` is the bearer token clients must present; when unset,
  any non-empty bearer token is accepted (local dev only).

## What is implemented

- **Git smart HTTP** (`gitproto.ts` + `store.ts`): v2 advertisement
  (`version 2`, `fetch=shallow filter`, `ls-refs=unborn`,
  `object-format=sha1`), v2 `ls-refs` (HEAD symref, peeled annotated tags,
  ref-prefix filtering), v2/v0 `fetch` (thin-pack, depth/shallow/deepen with
  boundary + unshallow reporting, haves subtraction — no held object is
  re-sent), v0 receive-pack advertisement, receive-pack with fast-forward
  checks (`non-fast-forward` per-ref, mixed ok/ng reports), packfile
  encode/decode (plain objects on write; delta resolution on read).
- **REST v3** (`rest.ts`): repos (create/get/patch/delete, pagination with
  `Link: rel="next"`), branches, commits, git refs, contents (create/update/
  delete with 409 stale-sha, branch auto-creation from the default tip),
  labels, issues, comments, pull requests (squash merge, conflict detection
  → 405).
- **GraphQL** (`graphql.ts`): hand-written parser + executor — variables,
  aliases, inline fragments, input objects, null variables, batching;
  `viewer`, `repository`, `node`, `__type` introspection, issue/PR
  connections with cursor pagination, all five mutations.
- **MCP** (`mcp.ts`): JSON-RPC 2.0, era `2026-07-28` (`server/discover`) +
  legacy `initialize`; six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) with minimal
  required args; tools/list is a single constant (byte-identical); unknown
  tool → -32602, malformed JSON → HTTP 400 / -32700.
- **Determinism**: no wall-clock, no randomness. API-created commits use a
  fixed base epoch (1700000000) plus a per-repo counter; request ids are
  sequential counters; all JSON key order is fixed.

## Files

| File | Size | Role |
|------|------|------|
| `main.ts` | 4.7 KB | Kit starter lifecycle (verbatim) |
| `app.ts` | 9.3 KB | HTTP server: auth, body, routing, replies |
| `store.ts` | 34 KB | In-memory model, git objects, pack codec, repo/issue/PR ops |
| `gitproto.ts` | 18 KB | Git smart-HTTP protocol |
| `rest.ts` | 23 KB | REST v3 handlers |
| `graphql.ts` | 28 KB | GraphQL parser + executor |
| `mcp.ts` | 10 KB | MCP endpoint + tools |
| `README.md` | 2.5 KB | Real content, no badges (parent adds them at submit) |
| `LICENSE` | 1.1 KB | MIT with `SPDX-License-Identifier: MIT` |
| `.makefun/owner.json` | 57 B | `{"wallet":"5UQLoiSXiq7zZvWXYBwNVSrdeJaPucEmb6PEoJCr9HXm"}` |

Total ≈ 131 KB (limit 16 MiB; largest single file 34 KB, limit 8 MiB).
Local git repo initialised in this directory, one commit (`de8ff6a`).

## Known gaps / notes

- Pack writing is plain objects only (no deltas generated). The suite's
  `pack-deltas` check passes because it only requires deltas to resolve
  *when the server sends them*; the client never sends deltas either, but
  inbound packs with deltas are resolved (ofs-delta and ref-delta).
- `deepen-since` / `deepen-not` and `filter` lines in fetch requests are
  accepted and ignored (no check exercises them).
- Perf is machine-noise sensitive: push 42–44, clone 30–37, write 47–49
  across runs; read is a stable 50 after the single-issue JSON cache.
- The empty-repo `ls-refs` deliberately returns no `refs/` names (only a
  zero-oid HEAD line): the conformance contract requires a fresh repository
  to advertise zero refs, even though real git would list an unborn ref.
- No GitHub repo was created and no bundle/submit was run — that is the
  parent's step (README badges, browser upload, bundle, submit).

## Parent's next steps

1. Create the GitHub repo and push this directory.
2. Add README badges at submit time (none are invented here).
3. Run bundle + submit before **2026-11-21 14:30 CST** (competition deadline).
