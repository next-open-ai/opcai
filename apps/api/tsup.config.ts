import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Contracts are part of the API's executable boundary, not a separate runtime package.
  noExternal: ['@opcai/contracts', '@opcai/agent-core', '@opcai/tools', '@opcai/orchestrator'],
  // Native addon; resolve at runtime from node_modules instead of bundling.
  external: ['@lancedb/lancedb'],
});
