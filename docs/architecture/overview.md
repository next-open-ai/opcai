# OPCAI architecture baseline

## Boundaries

- `apps/desktop` owns only Electron lifecycle, native dialogs, controlled IPC, and packaging.
- `apps/renderer` is a browser-only Vue application. It has no Node or Electron imports.
- `apps/api` is a localhost-only Fastify service and the renderer's HTTP boundary.
- `packages/agent-core` is the only permitted owner of Vercel AI SDK calls.
- `packages/tools` owns tool contracts and risk labels; approval policy belongs to agent-core.
- `packages/contracts` is the shared Zod schema source of truth.
- `packages/storage` will own the SQLite implementation when persisted sessions are added.

## Runtime

Electron starts the local API as a child process, waits for `/api/health`, then loads the renderer. Development uses Vite with a local API proxy. Production uses the renderer's static files and calls localhost directly.

## Dependency policy

- Use one validation library: Zod.
- Use one agent/model SDK: Vercel AI SDK.
- Use one HTTP server: Fastify.
- Do not import Electron from the renderer.
- Avoid provider-specific SDKs until a provider needs non-compatible API functionality.
