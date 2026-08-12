# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Codex, OpenClaw, …) working
in this repository. Humans: see [`CONTRIBUTING.md`](./CONTRIBUTING.md) — this
file is the same contract in agent-readable form. Read this before opening a PR.

Patter is open-source telephony infrastructure that connects AI agents to phone
calls. It ships **two SDKs with full parity**: Python (`pip install getpatter`,
`libraries/python/`) and TypeScript (`npm install getpatter`,
`libraries/typescript/`).

## Non-negotiables (CI and reviewers block on these)

1. **Feature parity.** Every user-visible feature lands in **BOTH** SDKs in the
   same PR, with the same API shape and defaults. Names map `snake_case`
   (Python) ↔ `camelCase` (TypeScript); everything else (field order, default
   values, error classes) matches. No Python-only or TS-only public surface.
2. **`CHANGELOG.md` in the same PR.** Append an entry under `## Unreleased`
   (`### Added` / `### Changed` / `### Fixed` / `### Deprecated` / `### Removed`
   / `### Security`) for any user-visible change. Exempt: pure refactors,
   test-only, docs-only — note that in the PR description.
3. **Opt-in, backward-compatible.** New config fields are optional with safe
   defaults. Never change an existing default or require a new credential.
4. **Authentic tests.** Tests exercise real code paths. Mock ONLY the
   paid/external boundary (provider/carrier WebSocket, carrier HTTP) — tag
   Python mocks `@pytest.mark.mocked`, name TS mocks `*.mocked.test.ts`.
5. **No secrets / PII.** No real API keys, phone numbers, emails, or customer
   SIDs in code, tests, docs, or notebooks. Use env vars + placeholders.
6. **No external license headers or "ported from <repo>" provenance comments**
   in source files. Naming a provider/carrier you integrate (Twilio, Telnyx,
   Plivo, OpenAI, ElevenLabs, Deepgram, …) is expected and fine; copying a
   competitor SDK's lineage/headers is not.
7. **Async everywhere.** All I/O is `async` (Python `asyncio`, TS Promises).
   Logger: Python `logging.getLogger("getpatter")`, TS `getLogger()` — never
   `print()` / bare `console.*` in library code.
8. **NO Workers to route voice traffic.** Never route real-time carrier audio streams (WebSockets / Webhooks) through intermediate Worker scripts due to Worker CPU and wall-time execution limits. Use direct container ingress routes, Cloudflare Tunnels (`cloudflared`), or Cloudflare Load Balancer direct origins.
9. **Use Cloudflare MCP for infrastructure operations.** Always leverage the installed Cloudflare Model Context Protocol (MCP) server for managing, querying, or inspecting Cloudflare infrastructure (Load Balancers, Workers, Containers, Workers KV, R2, DNS, Tunnels).
10. **Terminology: "Actors" vs "Workers".** Refer to internal application processing units, container instances, or background engines as **Actors**. The term **Workers** refers strictly to Cloudflare's serverless infrastructure platform (Cloudflare Workers).
11. **Actor Container Capacity Limits.** Container instance capacities for real-time voice handling are strictly bounded by hardware tier: `standard-3` (2 vCPU, 8 GiB RAM) handles a maximum of **2 concurrent calls**; `standard-4` (4 vCPU, 12 GiB RAM) handles a maximum of **4 concurrent calls**.
12. **Container Build Verification.** Before executing live integration/capacity tests against Cloudflare container deployments, always verify that the deployed container image rollout matches the latest commit hash on GitHub `main`.
13. **Mac Local Dev vs Cloudflare Linux Environment.** Local development runs on macOS. Local macOS architecture (ARM64/Virtualization) differs from Cloudflare Edge Linux (`x86_64`). Avoid local Docker daemon builds for production deployments.
14. **No `--containers-rollout=none` or Local Wrangler Container Builds.** Never execute `wrangler deploy --containers-rollout=none` or trigger local Docker container builds via Wrangler. All container images and Worker releases MUST be built and rolled out 100% in the cloud via Cloudflare's automated GitHub Integration upon `git push origin main`.
15. **Independent Temporal Deployment & Container Isolation.** The Temporal Server & UI infrastructure is 100% decoupled from `Patter-UtterPlus`. It maintains its own dedicated GitHub repository (`designbyjr/Patter-Temporal`), its own independent GitHub Actions CI/CD deployment pipeline, and executes in its own separate isolated container instance. Never route Temporal UI or gRPC traffic through the `Patter-UtterPlus` main Worker or `wrangler.toml`.





## Before opening a PR

```bash
bash scripts/pr-validate.sh          # mirrors PR-blocking CI (~3-5 min)
bash scripts/pr-validate.sh --quick  # pre-commit + lint (~30 s)
```

A green local run lines up with green CI (Python 3.11/3.12/3.13, TypeScript
20/22, pre-commit/lint, security).

## Where things live

```
libraries/python/getpatter/   Python SDK   (client.py, models.py, server.py,
                                            telephony/, providers/, services/)
libraries/typescript/src/     TypeScript SDK (client.ts, types.ts, server.ts,
                                            stream-handler.ts, telephony/, …)
docs/                         Mintlify docs site
scripts/pr-validate.sh        Local mirror of PR-blocking CI
```

Per-library quickstarts (committed alongside each SDK):
`libraries/python/CLAUDE.md` and `libraries/typescript/CLAUDE.md` — read the one
for the SDK you're touching.

## Commits & PRs

- Conventional commits: `feat:`, `fix:`, `perf:`, `docs:`, `chore:`,
  `refactor:`, `test:`.
- Branch off `main`; open the PR against `main`. Do not push to `main`
  directly. The PR template's checklist is mandatory — fill it honestly.
