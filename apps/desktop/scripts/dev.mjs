import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
let vite;
let electron;
let stopping = false;
let restarting = false;
let restartTimer;

function run(command, args, options = {}) { return spawn(command, args, { cwd: repoRoot, stdio: 'inherit', ...options }); }
function startElectron() {
  electron = run(pnpm, ['exec', 'electron', '.'], { cwd: desktopRoot, env: { ...process.env, OPCAI_RENDERER_URL: 'http://127.0.0.1:5173' } });
  electron.on('exit', (code) => {
    if (restarting) { restarting = false; startElectron(); return; }
    if (!stopping) { vite?.kill('SIGTERM'); process.exit(code ?? 0); }
  });
}
function restartElectron() {
  if (!electron || restarting) return;
  restarting = true;
  electron.kill('SIGTERM');
}
function stop() { stopping = true; clearTimeout(restartTimer); electron?.kill('SIGTERM'); vite?.kill('SIGTERM'); }

const build = run(pnpm, ['--filter', '@opcai/contracts', 'build']);
build.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const agentBuild = run(pnpm, ['--filter', '@opcai/agent-core', 'build']);
  agentBuild.on('exit', (agentCode) => {
    if (agentCode !== 0) process.exit(agentCode ?? 1);
    const apiBuild = run(pnpm, ['--filter', '@opcai/api', 'build']);
    apiBuild.on('exit', (apiCode) => {
      if (apiCode !== 0) process.exit(apiCode ?? 1);
      vite = run(pnpm, ['--filter', '@opcai/renderer', 'dev']);
      startElectron();
      // Renderer changes are handled by Vite HMR. Restart Electron only for IPC/main changes.
      watch(path.join(desktopRoot, 'src'), { recursive: process.platform !== 'linux' }, (_event, filename) => {
        if (!filename || !/^(main|preload)[/\\]/.test(filename)) return;
        clearTimeout(restartTimer);
        restartTimer = setTimeout(restartElectron, 180);
      });
    });
  });
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
