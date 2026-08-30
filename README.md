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

## Release

Push a SemVer tag such as `v0.1.0`. The release workflow validates the tag and uses it as the version of all packaged manifests before Electron Builder creates platform artifacts.

Linux releases currently publish an AppImage. A Debian `.deb` package will be enabled once the project's public maintainer name and email are configured, as Debian metadata requires both.

## Architecture

```text
Electron shell -> local Fastify API -> agent-core -> Vercel AI SDK
                    |                  |              |
                    +-> storage         +-> tools      +-> providers
Vue renderer ------- HTTP / SSE --------+
```
