# OPCAI

**OPCAI — a cross-platform, local-first AI workspace for digital employees.**

> **Languages:** [中文 (zh-CN)](README.zh-CN.md) · English
>
> 本项目 README 采用「根 README 为索引 + 语言分档」结构（语言分档见上）。

---

OPCAI is a desktop agent workspace whose agents ("digital employees") can chat, run **projects**, use **Skills**, query **knowledge bases / MCP connectors / web search**, and be driven from **external channels** (Telegram / Feishu / a remote relay) through a local gateway. Every heavy piece of orchestration lives in a **server-side state machine**, so the desktop UI, IM channels and future remote terminals all share one consistent view of sessions, runs, approvals and project scheduling.

The repository deliberately keeps the Electron shell thin:

```text
Electron shell  →  local Fastify API  →  agent-core (Vercel AI SDK)  →  providers
Vue renderer ────── HTTP / SSE ────────┘
channel gateway ─── HTTP / SSE ─────────┘   (Telegram / Feishu / remote relay)
```

## Highlights

| Capability | Description |
| --- | --- |
| Digital employees | Responsibility/authorization units with configurable model, Skills, runtime prefs and permission tiers |
| Skills (progressive disclosure) | Authorize → `SKILL.md` on demand → resources/scripts within an isolated run workspace |
| Project orchestration | Goal → **Plan vN** (DAG) → confirm → **Run**; follow-ups apply a **ChangeSet** (stale cascade); roster changes bump Plan and keep reusable completed nodes |
| Resumable approvals | Tool approval parks a run (`waiting-approval`); deciding it re-runs the same turn automatically |
| Session rolling memory | Per-session `memory.summary` + watermark; auto-summarize over budget, flush on leave; transcript stays source of truth |
| Dual project workspaces | Process files stay in per-run agent workspaces; final deliverables use `publish_to_project` into the shared project tree |
| Knowledge / MCP / Web search | Local LanceDB + cloud KBs, MCP connectors (http/sse/stdio), multi-provider search with masking |
| Channels & remote office | Gateway child process: Telegram & Feishu adapters, personal allowlist, **remote relay** device link (WS outbound) for terminals |
| Local-first storage | One durable domain store owned by the API process; secrets stay encrypted in the main process (`safeStorage`) and are only released over fork IPC |
| Desktop "Remote & Channels" portal | P1 view to manage Telegram/Feishu credentials, allowlist, default employee, gateway status/restart |

## Repository layout (pnpm monorepo)

| Path | Role |
| --- | --- |
| `apps/desktop` | Electron main (thin), IPC, sql.js secret/asset store, forks api + gateway |
| `apps/renderer` | Browser-only Vue 3 UI (Vite + Tailwind); talks HTTP/SSE + IPC |
| `apps/api` | Localhost Fastify service; hosts the **orchestrator** (`/api/orch/**`) |
| `apps/gateway` | Channel-gateway child process (Telegram/Feishu/relay adapters, allowlist) |
| `packages/contracts` | Shared Zod contract source of truth |
| `packages/agent-core` | The only layer that calls the Vercel AI SDK |
| `packages/tools` | Tool contracts + risk labels |
| `packages/orchestrator` | Server-side session/project state machines, storage service, resumable runs |
| `packages/channel` | Transport-agnostic channel protocol (`UnifiedMessage/IChannel/registry/StreamSink`) |
| `packages/storage`, `packages/ui-kit` | Reserved placeholders |

See [docs/design/architecture.md](docs/design/architecture.md) for the full current architecture and module responsibilities.

## Quick start

Requirements: Node.js ≥ 22, pnpm ≥ 10 (pinned via `packageManager`).

```bash
pnpm install
pnpm dev        # desktop (builds workspace packages, starts Vite + Electron)
pnpm typecheck
pnpm build
pnpm package    # electron-builder installers
```

No model credentials are stored or used until you configure a provider in **Settings → Models**. Headless/CI smoke scripts are also provided (see `scripts/*-smoke.mjs` and the design docs).

## Release

Push a SemVer tag such as `v0.1.0`; the release workflow packages and publishes three installers:

| Platform | Architecture | Installer |
| --- | --- | --- |
| macOS | Apple Silicon (arm64) | `.dmg` |
| macOS | Intel (x64) | `.dmg` |
| Windows | x64 | NSIS `.exe` |

Linux packaging stays disabled in CI for now (see the workflow comments in `.github/workflows/release.yml`).

## Documentation

| Language | Index |
| --- | --- |
| 中文 | [docs/design/architecture.md](docs/design/architecture.md) · [docs/design README](docs/design/README.md) · [网关设计](docs/design/gateway-m0.md) (M0) / [M1](docs/design/gateway-m1.md) / [M2](docs/design/gateway-m2.md) |
| English | See the feature/milestone tables inside the design docs above (deep design notes are currently maintained in Chinese). |

## Status of the channel-gateway milestones

| Milestone | Result |
| --- | --- |
| M0 Orchestration layer | ✅ sessions/projects state machines, storage service, resumable approvals, `/api/orch` REST+SSE |
| M1 Gateway + Telegram | ✅ `@opcai/channel`, `apps/gateway`, Telegram adapter + allowlist, stub acceptance ALL PASS |
| M2 Remote-office portal, Feishu, relay | ✅ P1 portal & credential channel (IPC + `safeStorage`), P2 Feishu adapter, P3 minimal remote relay — stub acceptances ALL PASS |

## License

The project does not yet declare a public license file — treat it as internal until a `LICENSE` is added by the owner.
