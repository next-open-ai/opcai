import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appsRoot = path.resolve(desktopRoot, '..');
const stageRoot = path.join(desktopRoot, '.stage');
const sources = [
  { from: path.join(appsRoot, 'renderer', 'dist'), to: path.join(stageRoot, 'renderer') },
  { from: path.join(appsRoot, 'api', 'dist'), to: path.join(stageRoot, 'api') },
];

rmSync(stageRoot, { recursive: true, force: true });
for (const source of sources) {
  if (!existsSync(source.from)) throw new Error(`Missing build output: ${source.from}`);
  cpSync(source.from, source.to, { recursive: true, dereference: true });
}
