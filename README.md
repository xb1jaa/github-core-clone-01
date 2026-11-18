# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/{owner}/{repo}/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/{owner}/{repo}/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, no dependencies: git smart HTTP (protocol v2 and v0, packfiles, shallow fetch/deepen, sideband report-status), REST API v3 (repos, branches, commits, contents, issues, pull requests), GraphQL API v4 (introspection, global IDs, cursor pagination, mutations), and an MCP server (server/discover, 6 tools). Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

Requires Node 22 or later. The process registers itself with the trial environment (`$MAKEFUN_ENV_URL/register`), answers `GET /healthz`, and serves the forge on its port until the trial ends. All state is in memory; nothing is written to disk.

## Surfaces

- `GET /healthz` — liveness.
- `/<owner>/<repo>.git/*` — git smart HTTP (info/refs, upload-pack, receive-pack).
- `/api/v3/*` — REST v3. Any non-empty Bearer token is the viewer; no token is 401.
- `/api/graphql` — GraphQL v4.
- `/mcp` — MCP (server/discover, tools/list, tools/call).

## Local checks

The kit's conformance suite (120 checks + 4 benchmark workloads) runs against a
locally started server:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18777 --token test-token --perf
```

from the unpacked kit directory, with the entry running on port 18777.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4r01e97f&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
