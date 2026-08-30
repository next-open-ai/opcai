import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, options = {}) {
  return spawn(command, args, { cwd: repoRoot, stdio: 'inherit', ...options });
}

const build = run(pnpm, ['--filter', '@opcai/contracts', 'build']);
build.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const apiBuild = run(pnpm, ['--filter', '@opcai/api', 'build']);
  apiBuild.on('exit', (apiCode) => {
    if (apiCode !== 0) process.exit(apiCode ?? 1);
    const vite = run(pnpm, ['--filter', '@opcai/renderer', 'dev']);
    const electron = run(pnpm, ['exec', 'electron', '.'], {
      cwd: desktopRoot,
      env: { ...process.env, OPCAI_RENDERER_URL: 'http://127.0.0.1:5173' },
    });
    const close = () => { vite.kill('SIGTERM'); electron.kill('SIGTERM'); };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
    electron.on('exit', (electronCode) => { vite.kill('SIGTERM'); process.exit(electronCode ?? 0); });
  });
});
