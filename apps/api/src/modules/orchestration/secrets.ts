import { readFileSync } from 'node:fs';

/**
 * Parent-process secrets channel (M0 keyring).
 *
 * Model/search provider secrets live only in the Electron main process behind
 * `safeStorage`. When the API runs as the desktop's forked child it requests a
 * one-time decrypted snapshot over the fork IPC channel (`opcai:secrets`); the
 * snapshot stays in this process's memory and is never persisted or logged.
 * Standalone (`node dist/main.cjs`) runs simply get an empty keyring and any
 * server-side context assembly degrades to "no model configured".
 */

export interface OpcaiSecrets {
  model?: unknown;
  search?: unknown;
}

let cache: OpcaiSecrets | null = null;
let requested = false;

export function getSecrets(): OpcaiSecrets {
  return cache ?? {};
}

function loadSecretsFile(): OpcaiSecrets | null {
  const file = process.env.OPCAI_SECRETS_FILE;
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as OpcaiSecrets;
    return { model: parsed.model, search: parsed.search };
  } catch {
    return null;
  }
}

export function requestParentSecrets(timeoutMs = 4_000): Promise<void> {
  if (requested) return Promise.resolve();
  requested = true;
  // Local acceptance/dev shortcut: seed the keyring from a JSON file
  // (OPCAI_SECRETS_FILE: {model?, search?}). Never used in desktop runs.
  const fromFile = loadSecretsFile();
  if (fromFile) {
    cache = fromFile;
    return Promise.resolve();
  }
  if (!process.send || typeof process.on !== 'function') {
    cache = {};
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      process.off?.('message', onMessage);
      resolve();
    }, timeoutMs);
    function onMessage(message: unknown) {
      const payload = message as { type?: string; payload?: OpcaiSecrets } | null;
      if (!payload || payload.type !== 'opcai:secrets') return;
      clearTimeout(timer);
      process.off?.('message', onMessage);
      cache = { model: payload.payload?.model, search: payload.payload?.search };
      resolve();
    }
    process.on('message', onMessage);
    process.send?.({ type: 'opcai:secrets:request' });
  });
}
