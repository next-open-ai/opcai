import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const requestedPort = Number(process.env.OPCAI_API_PORT || '4518');
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'opcai-web-smoke-'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function fetchOk(url, expectJson = false) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return expectJson ? response.json() : response.text();
}

async function main() {
  const child = spawn(process.execPath, ['scripts/start-web.mjs'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      OPCAI_API_PORT: String(requestedPort),
      OPCAI_DATA_DIR: dataDir,
    },
  });

  try {
    await waitFor(async () => {
      const health = await fetchOk(`http://127.0.0.1:${requestedPort}/api/health`, true);
      assert.equal(health.status, 'ok');
      return true;
    }, 20_000, 'web health');

    const index = await waitFor(async () => {
      const html = await fetchOk(`http://127.0.0.1:${requestedPort}/`);
      return /<html/i.test(html) ? html : null;
    }, 10_000, 'web index');
    assert.match(index, /OPCAI/i);

    const remote = await fetchOk(`http://127.0.0.1:${requestedPort}/api/remote/gateway/status`, true);
    assert.equal(typeof remote.running, 'boolean');

    console.log('[web-smoke] ALL PASS');
  } finally {
    child.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[web-smoke] FAILED:', error.message);
  process.exit(1);
});
