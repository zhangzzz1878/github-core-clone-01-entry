# github-core-clone-01-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zhangzzz1878/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zhangzzz1878/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, dependency-free (Node 22 built-ins only) GitHub-compatible git forge. It speaks the git smart-HTTP protocol (v2 and v0), the GitHub REST API v3, a GraphQL API, and the Model Context Protocol — all against one in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

## What it implements

- **Git smart HTTP** — `info/refs`, `git-upload-pack` (protocol v2 `ls-refs`
  and `fetch`, plus v0 fetch), `git-receive-pack` with fast-forward checks,
  report-status sideband reports, shallow/deepen clones, and packfile
  encoding/decoding (including delta resolution on read; packs are written
  without deltas).
- **REST v3** — repositories, branches, commits, git refs, contents
  (create/update/delete files and directories), labels, issues, comments and
  pull requests (including squash merge with conflict detection).
- **GraphQL** — `viewer`, `repository`, `node`, `__type` introspection,
  issue/pull-request connections with cursor pagination, and the
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations.
- **MCP** — JSON-RPC 2.0, modern era `2026-07-28` (`server/discover`) with a
  legacy `initialize` fallback, and six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

The entry binds an ephemeral port, registers it with the environment named
by `MAKEFUN_ENV_URL`, and exits when the environment reports done. Without
`MAKEFUN_ENV_URL` it exits 1. Set `MAKEFUN_SHOP_TOKEN` to the bearer token
clients must present; when it is unset, any non-empty bearer token is
accepted (local development only).

## Layout

- `main.ts` — the entry lifecycle (kept as provided by the kit).
- `app.ts` — HTTP server: auth, body reading, routing, replies.
- `store.ts` — in-memory data model, git object layer, pack codec,
  repository/issue/pull-request operations.
- `gitproto.ts` — git smart-HTTP protocol (pkt-lines, advertisements,
  ls-refs, fetch planning, receive-pack).
- `rest.ts` — GitHub REST API v3 handlers.
- `graphql.ts` — GraphQL parser and executor.
- `mcp.ts` — MCP endpoint and tools.

## Determinism

State is purely a function of the request sequence: no wall-clock time, no
randomness. API-created commits use a fixed base epoch plus a per-repository
counter for their timestamps, and request ids are sequential counters.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4mdg389a&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
