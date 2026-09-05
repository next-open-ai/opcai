#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { apiEntry, defaultDataDir, startWebLauncher, staticDir } from '../scripts/lib/web-launcher.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const command = process.argv[2] || 'start';

function printDoctor() {
  const dataDir = defaultDataDir();
  process.stdout.write(`OPCAI ${packageJson.version}\n`);
  process.stdout.write(`projectRoot: ${projectRoot}\n`);
  process.stdout.write(`dataDir: ${dataDir}\n`);
  process.stdout.write(`apiBuild: ${apiEntry(projectRoot)} (${existsSync(apiEntry(projectRoot)) ? 'ok' : 'missing'})\n`);
  process.stdout.write(`rendererBuild: ${path.join(staticDir(projectRoot), 'index.html')} (${existsSync(path.join(staticDir(projectRoot), 'index.html')) ? 'ok' : 'missing'})\n`);
  process.stdout.write(`home: ${os.homedir()}\n`);
}

switch (command) {
  case 'version':
  case '--version':
  case '-v':
    process.stdout.write(`${packageJson.version}\n`);
    break;
  case 'doctor':
    printDoctor();
    break;
  case 'init': {
    const dataDir = defaultDataDir();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    process.stdout.write(`OPCAI data dir ready\nroot: ${dataDir}\n`);
    break;
  }
  case 'start':
  default:
    await startWebLauncher(projectRoot);
    break;
}
