# OPCAI

OPCAI is a cross-platform local AI workspace. This repository deliberately keeps the Electron shell thin: the Vue renderer is independent, Fastify exposes the local API, and the agent core is the only layer that uses Vercel AI SDK.

## Prerequisites

- Node.js 22+
- pnpm 10+

## Commands

```bash
pnpm install
pnpm dev
pnpm build
pnpm typecheck
pnpm package
```

The initial scaffold exposes a health endpoint and a minimal desktop screen. No model credentials are stored or used yet.

## Architecture

```text
Electron shell -> local Fastify API -> agent-core -> Vercel AI SDK
                    |                  |              |
                    +-> storage         +-> tools      +-> providers
Vue renderer ------- HTTP / SSE --------+
```
