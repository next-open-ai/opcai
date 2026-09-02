const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, screen } = require('electron');
const { fork, execFile } = require('node:child_process');
const { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const path = require('node:path');

const apiPort = Number(process.env.OPCAI_API_PORT || 4318);
let mainWindow;
let apiProcess;
let database;
const storageRoot = () => path.join(app.getPath('home'), '.opcai');
const databaseFile = () => path.join(storageRoot(), 'opcai.sqlite');

async function initializeDatabase() {
  mkdirSync(storageRoot(), { recursive: true, mode: 0o700 });
  const sqlJsRoot = app.isPackaged ? path.join(app.getAppPath(), 'stage', 'sqljs') : path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const initSqlJs = require(path.join(sqlJsRoot, 'sql-wasm.js'));
  const SQL = await initSqlJs({ wasmBinary: readFileSync(path.join(sqlJsRoot, 'sql-wasm.wasm')) });
  database = new SQL.Database(existsSync(databaseFile()) ? readFileSync(databaseFile()) : undefined);
  database.run('CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  database.run('CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, conversation_id TEXT, employee_id TEXT, run_id TEXT NOT NULL, sha256 TEXT NOT NULL)');
  database.run('CREATE INDEX IF NOT EXISTS assets_created_at ON assets(created_at DESC)');
  flushDatabase();
}

function flushDatabase() { writeFileSync(databaseFile(), Buffer.from(database.export()), { mode: 0o600 }); }
function getStoredValue(key) { const result = database.exec('SELECT value FROM app_kv WHERE key = ?', [key]); return result[0]?.values[0]?.[0] ?? null; }
function setStoredValue(key, value) { database.run('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', [key, value, Date.now()]); flushDatabase(); }

function assetMimeType(name) {
  const extension = path.extname(name).toLowerCase();
  return ({ '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.zip': 'application/zip' })[extension] || 'application/octet-stream';
}
function assetRows(result) { return (result[0]?.values || []).map(([id, name, relativePath, mimeType, sizeBytes, createdAt, conversationId, employeeId, runId, sha256]) => ({ id, name, relativePath, mimeType, sizeBytes, createdAt, conversationId, employeeId, runId, sha256 })); }
function listAssets() { return assetRows(database.exec('SELECT id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256 FROM assets ORDER BY created_at DESC')); }
function archiveArtifact(value) {
  const runId = String(value?.runId || '');
  const relativePath = String(value?.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/^[a-f0-9-]{20,}$/i.test(runId) || !relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid artifact location.');
  const workspaceRoot = path.resolve(storageRoot(), 'workspaces', runId);
  const source = path.resolve(workspaceRoot, relativePath);
  if (!source.startsWith(`${workspaceRoot}${path.sep}`) || !existsSync(source) || !statSync(source).isFile()) throw new Error('Generated artifact is no longer available.');
  const sizeBytes = statSync(source).size;
  if (sizeBytes > 100 * 1024 * 1024) throw new Error('Generated artifact exceeds the 100 MB asset limit.');
  const id = randomUUID();
  const name = path.basename(source);
  const targetFolder = path.join(storageRoot(), 'assets', id);
  mkdirSync(targetFolder, { recursive: true, mode: 0o700 });
  const target = path.join(targetFolder, name);
  copyFileSync(source, target, 0);
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  const relativeAssetPath = path.relative(storageRoot(), target).split(path.sep).join('/');
  const createdAt = Date.now();
  database.run('INSERT INTO assets (id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, name, relativeAssetPath, assetMimeType(name), sizeBytes, createdAt, String(value?.conversationId || '') || null, String(value?.employeeId || '') || null, runId, sha256]);
  flushDatabase();
  return { id, name, relativePath: relativeAssetPath, mimeType: assetMimeType(name), sizeBytes, createdAt, conversationId: String(value?.conversationId || '') || null, employeeId: String(value?.employeeId || '') || null, runId, sha256 };
}
function assetFile(assetId) {
  const row = assetRows(database.exec('SELECT id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256 FROM assets WHERE id = ?', [String(assetId)]))[0];
  if (!row) throw new Error('Asset not found.');
  const target = path.resolve(storageRoot(), row.relativePath);
  if (!target.startsWith(`${path.resolve(storageRoot(), 'assets')}${path.sep}`) || !existsSync(target)) throw new Error('Asset file is unavailable.');
  return { row, target };
}

function safeProjectFolderName(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/gi, '-').replace(/(^-|-$)/g, '').slice(0, 64) || 'project'; }
function projectRoot(folder) { const root = path.resolve(String(folder || '')); if (!root || root === path.parse(root).root) throw new Error('Invalid project workspace.'); return root; }
function projectPath(root, relative) { const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, ''); if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid project file path.'); const target = path.resolve(projectRoot(root), normalized); if (!target.startsWith(`${projectRoot(root)}${path.sep}`)) throw new Error('Project file is outside its workspace.'); return target; }
function createProjectWorkspace(value) {
  const parent = value?.parentDirectory ? path.resolve(String(value.parentDirectory)) : path.join(storageRoot(), 'projects');
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const folder = `${safeProjectFolderName(value?.name)}-${randomUUID().slice(0, 8)}`;
  const root = path.join(parent, folder);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
function listProjectFiles(root, directory = projectRoot(root), relative = '', depth = 0, result = []) {
  if (depth > 8 || !existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.python-packages') continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { result.push({ relative: childRelative, type: 'directory' }); listProjectFiles(root, target, childRelative, depth + 1, result); }
    else if (entry.isFile() && statSync(target).size <= 8 * 1024 * 1024) result.push({ relative: childRelative, type: 'file' });
  }
  return result;
}
function readProjectFile(root, relative) { const file = projectPath(root, relative); if (!existsSync(file) || !statSync(file).isFile()) throw new Error('Project file is unavailable.'); return { relative, content: readFileSync(file, 'utf8') }; }
function writeProjectFile(root, relative, content) { const file = projectPath(root, relative); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, String(content), { mode: 0o600 }); return { relative, content: String(content) }; }
function syncRunWorkspaceToProject(root, runId) {
  const source = path.join(storageRoot(), 'workspaces', String(runId));
  if (!existsSync(source)) return [];
  const target = projectRoot(root);
  cpSync(source, target, {
    recursive: true,
    filter: (from) => {
      const base = path.basename(from);
      if (['.python-packages', '__pycache__', '.DS_Store'].includes(base)) return false;
      // Agent scaffolding / process scripts are not project deliverables.
      if (/\.(py|sh)$/i.test(base)) return false;
      return true;
    },
  });
  return listProjectFiles(target);
}
function materializeProjectAssets(root, assetIds) {
  const target = projectRoot(root);
  const ids = Array.isArray(assetIds) ? assetIds.map((id) => String(id || '')).filter(Boolean) : [];
  for (const assetId of ids) {
    try {
      const { row, target: source } = assetFile(assetId);
      let name = row.name;
      let dest = path.join(target, name);
      if (existsSync(dest)) {
        const ext = path.extname(name);
        const stem = path.basename(name, ext);
        name = `${stem}-${assetId.slice(0, 8)}${ext}`;
        dest = path.join(target, name);
      }
      copyFileSync(source, dest, 0);
    } catch (_) { /* Skip missing assets so one failure does not block the tree. */ }
  }
  return listProjectFiles(root);
}

function readModelConfig() {
  try {
    const stored = getStoredValue('model-settings');
    if (!stored) return {};
    const config = JSON.parse(stored);
    if (Array.isArray(config.providers)) config.providers = config.providers.map((provider) => ({ ...provider, apiKey: provider.apiKey && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(provider.apiKey, 'base64')) : provider.apiKey || '' }));
    else if (config.apiKey && safeStorage.isEncryptionAvailable()) config.apiKey = safeStorage.decryptString(Buffer.from(config.apiKey, 'base64'));
    return config;
  } catch (_) { return {}; }
}

function writeModelConfig(value) {
  const config = { activeProvider: String(value?.activeProvider || 'openai'), providers: Array.isArray(value?.providers) ? value.providers.map((provider) => ({ provider: String(provider.provider || ''), baseUrl: String(provider.baseUrl || ''), chatModel: String(provider.chatModel || ''), chatModels: Array.isArray(provider.chatModels) ? provider.chatModels.map((item) => String(item)) : [], imageModel: String(provider.imageModel || ''), embeddingModel: String(provider.embeddingModel || ''), asrModel: String(provider.asrModel || ''), ttsModel: String(provider.ttsModel || ''), apiKey: String(provider.apiKey || '') })) : [] };
  const persisted = { ...config, providers: config.providers.map((provider) => ({ ...provider, apiKey: provider.apiKey && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(provider.apiKey).toString('base64') : provider.apiKey })) };
  setStoredValue('model-settings', JSON.stringify(persisted));
  return config;
}

function safeSkillName(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 64); }
function normalizeSkillSource(value) {
  const source = String(value || '').trim();
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/.test(source)) return source;
  try {
    const url = new URL(source);
    if (url.protocol === 'https:' && /(^|\.)(github\.com|gitlab\.com|gitee\.com)$/i.test(url.hostname)) return url.toString().replace(/\.git$/, '');
  } catch (_) { /* invalid source */ }
  throw new Error('Enter a skill reference or an HTTPS GitHub, GitLab, or Gitee repository URL.');
}
function readSkillManifest(file) {
  if (!file || path.basename(file).toLowerCase() !== 'skill.md') throw new Error('Please choose a SKILL.md file.');
  const content = readFileSync(file, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match || !/^name:\s*.+/m.test(match[1]) || !/^description:\s*.+/m.test(match[1])) throw new Error('SKILL.md must include name and description frontmatter.');
  return { path: file, content };
}
function manifestName(content) {
  const raw = content.match(/^name:\s*(.+)$/mi)?.[1]?.trim() || '';
  return safeSkillName(raw.replace(/^['"]|['"]$/g, ''));
}
function findSkillManifests(directory, depth = 0, matches = []) {
  if (depth > 5) return matches;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) findSkillManifests(target, depth + 1, matches);
    else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') matches.push(readSkillManifest(target));
  }
  return matches;
}
function withoutAnsi(value) { return String(value || '').replace(/\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -\/]*[@-~])/g, '').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\s{2,}/g, ' ').trim(); }
function skillsSearchError(value) {
  const clean = withoutAnsi(value).replace(/[^\p{L}\p{N}\s:.,/@_\-()[\]]/gu, '').slice(-500);
  return clean ? `Skills.sh 搜索暂不可用：${clean}` : 'Skills.sh 搜索暂不可用。请稍后重试，或直接在 skills.sh 浏览技能。';
}
function registryResults(output) {
  const lines = withoutAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const items = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([^\s]+\/[^\s@]+@[^\s]+)\s+([\d.]+[KMB]?)\s+installs$/i);
    if (!match) continue;
    const reference = match[1];
    const [source, slug] = reference.split('@');
    const next = lines[index + 1]?.replace(/^└\s*/, '');
    items.push({ reference, source, slug, name: slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), description: '', installs: match[2], url: /^https:\/\//.test(next || '') ? next : `https://skills.sh/${source}/${slug}` });
  }
  return items;
}
async function enrichRegistryItem(item) {
  try {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return item;
    const html = await response.text();
    const encoded = html.match(/"description":"((?:\\.|[^"\\])+)"/)?.[1];
    const description = encoded ? JSON.parse(`"${encoded}"`) : '';
    return { ...item, description: String(description).trim().slice(0, 420) };
  } catch (_) { return item; }
}
function findManifest(directory, skillName) {
  const { readdirSync } = require('node:fs');
  const visit = (folder, depth) => {
    if (depth > 5) return null;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) { const found = visit(target, depth + 1); if (found) return found; }
      else if (entry.isFile() && entry.name === 'SKILL.md') {
        const manifest = readSkillManifest(target);
        if (!skillName || new RegExp(`^name:\\s*${skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(manifest.content)) return manifest;
      }
    }
    return null;
  };
  return visit(directory, 0);
}
function runSkillsCli(reference) {
  const source = normalizeSkillSource(reference);
  const skillsDirectory = path.join(storageRoot(), 'skills');
  mkdirSync(skillsDirectory, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => execFile(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['skills', 'add', source, '--yes'], { cwd: skillsDirectory, timeout: 120000, windowsHide: true }, (error, stdout, stderr) => {
    if (error) return reject(new Error(withoutAnsi(stderr || stdout || error.message).slice(-2000)));
    const manifest = findManifest(skillsDirectory, source.includes('@') ? source.split('@').pop() : null);
    resolve({ manifest, output: withoutAnsi(stdout || stderr).slice(-1000) });
  }));
}
async function importGitSkillRepository(value) {
  const source = normalizeSkillSource(value);
  if (!source.startsWith('https://')) throw new Error('Use an HTTPS Git repository URL.');
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'opcai-skill-'));
  const checkout = path.join(temporaryRoot, 'repository');
  try {
    await new Promise((resolve, reject) => execFile('git', ['clone', '--depth', '1', source, checkout], { timeout: 120000, windowsHide: true }, (error, _stdout, stderr) => error ? reject(new Error(`Unable to clone repository: ${String(stderr || error.message).slice(-1200)}`)) : resolve()));
    const imported = [];
    const skipped = [];
    for (const manifest of findSkillManifests(checkout)) {
      const name = manifestName(manifest.content);
      if (!name) { skipped.push(path.dirname(manifest.path)); continue; }
      const targetFolder = path.join(storageRoot(), 'skills', name);
      const target = path.join(targetFolder, 'SKILL.md');
      if (existsSync(target)) { skipped.push(name); continue; }
      mkdirSync(targetFolder, { recursive: true, mode: 0o700 });
      writeFileSync(target, manifest.content, { mode: 0o600 });
      // A portable skill commonly references one of these sibling folders.
      // Copy only declared resource locations rather than the entire repository.
      for (const resource of ['scripts', 'references', 'assets', 'agents']) {
        const sourceFolder = path.join(path.dirname(manifest.path), resource);
        if (existsSync(sourceFolder)) cpSync(sourceFolder, path.join(targetFolder, resource), { recursive: true, force: false });
      }
      imported.push(readSkillManifest(target));
    }
    if (!imported.length) throw new Error('No new valid SKILL.md file was found in this repository.');
    return { manifests: imported, skipped };
  } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
}
function writeSkillDraft(value) {
  const name = safeSkillName(value?.name);
  const content = String(value?.content || '');
  if (!name || content.length < 40 || content.length > 100000) throw new Error('Invalid skill draft.');
  if (!/^---\r?\n[\s\S]*?^name:\s*[^\r\n]+[\s\S]*?^description:\s*[^\r\n]+[\s\S]*?^---/m.test(content)) throw new Error('A skill draft must contain name and description frontmatter.');
  const folder = path.join(storageRoot(), 'skills', name);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, 'SKILL.md');
  writeFileSync(file, content, { mode: 0o600 });
  return readSkillManifest(file);
}
function readSkillDraft(file) {
  const root = path.resolve(storageRoot(), 'skills') + path.sep;
  const target = path.resolve(String(file || ''));
  if (!target.startsWith(root) || path.basename(target) !== 'SKILL.md') throw new Error('Skill file is outside the managed local skill library.');
  return readSkillManifest(target);
}
function managedSkillPath(file) {
  const root = path.resolve(storageRoot(), 'skills') + path.sep;
  const target = path.resolve(String(file || ''));
  if (!target.startsWith(root)) throw new Error('Skill file is outside the managed local skill library.');
  return target;
}
function listSkillFiles(file) {
  const root = path.dirname(managedSkillPath(file));
  const entries = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const target = path.join(folder, entry.name);
      const relative = path.relative(root, target);
      entries.push({ path: target, relative, type: entry.isDirectory() ? 'directory' : 'file' });
      if (entry.isDirectory()) visit(target);
    }
  };
  if (existsSync(root)) visit(root);
  return entries;
}
function readManagedSkillFile(file) { const target = managedSkillPath(file); return { path: target, content: readFileSync(target, 'utf8') }; }
function writeManagedSkillFile(file, content) {
  const target = managedSkillPath(file);
  if (String(content || '').length > 100000) throw new Error('Skill file is too large.');
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, String(content || ''), { mode: 0o600 });
  return { path: target, content: String(content || '') };
}
function deleteManagedSkill(file) {
  const root = path.resolve(storageRoot(), 'skills') + path.sep;
  const target = path.resolve(String(file || ''));
  if (!target.startsWith(root) || path.basename(target) !== 'SKILL.md') return false;
  rmSync(path.dirname(target), { recursive: true, force: true });
  return true;
}
function findSkills(query) {
  const value = String(query || '').trim();
  if (!value || value.length > 120) throw new Error('Enter a short skill search query.');
  return (async () => {
    let response;
    try { response = await fetch(`https://skills.sh/api/search?${new URLSearchParams({ q: value, limit: '20' })}`, { signal: AbortSignal.timeout(15000) }); }
    catch (cause) { throw new Error(skillsSearchError(cause instanceof Error ? cause.message : String(cause))); }
    if (!response.ok) throw new Error(`Skills.sh 搜索暂不可用（HTTP ${response.status}）。请稍后重试或在 skills.sh 浏览。`);
    const data = await response.json();
    const rawSkills = Array.isArray(data?.skills) ? data.skills : [];
    const items = await Promise.all(rawSkills.map((skill) => {
      const source = String(skill?.source || ''); const name = String(skill?.name || ''); const slug = String(skill?.id || ''); const installs = Number(skill?.installs || 0);
      const formattedInstalls = installs >= 1_000_000 ? `${(installs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : installs >= 1_000 ? `${(installs / 1_000).toFixed(1).replace(/\.0$/, '')}K` : installs ? String(installs) : '';
      return enrichRegistryItem({ reference: source && name ? `${source}@${name}` : slug, source, slug, name: name || slug.split('/').pop() || 'Skill', description: '', installs: formattedInstalls, url: `https://skills.sh/${slug}` });
    }));
    return { items, hasMore: false };
  })();
}

function apiEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'api', 'main.cjs')
    : path.resolve(__dirname, '../../../api/dist/main.cjs');
}

function startApi() {
  apiProcess = fork(apiEntry(), [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPCAI_API_PORT: String(apiPort),
      OPCAI_SKILLS_DIR: path.join(storageRoot(), 'skills'),
      OPCAI_WORKSPACES_DIR: path.join(storageRoot(), 'workspaces'),
      // The API is unpacked under Resources together with its minimal
      // production dependency closure, not the desktop workspace node_modules.
      ...(app.isPackaged ? { NODE_PATH: path.join(process.resourcesPath, 'api', 'node_deps') } : {}),
    },
    stdio: 'inherit',
  });
}

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
      if (response.ok) return;
    } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('OPCAI local API did not become ready.');
}

async function createWindow() {
  await waitForApi();
  const { width: workAreaWidth, height: workAreaHeight } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.round(workAreaWidth * 0.96),
    height: Math.round(workAreaHeight * 0.94),
    minWidth: 1180,
    minHeight: 760,
    show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    console.error(`[renderer] failed to load (${code}): ${description} (${validatedUrl})`);
  });
  mainWindow.webContents.on('console-message', (_event, details) => {
    if (details.level >= 2) console.error(`[renderer] ${details.sourceId}:${details.lineNumber} ${details.message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => console.error(`[renderer] process gone: ${details.reason}`));
  const rendererUrl = process.env.OPCAI_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else {
    const rendererEntry = app.isPackaged
      ? path.join(app.getAppPath(), 'stage', 'renderer', 'index.html')
      : path.resolve(__dirname, '../../../renderer/dist/index.html');
    await mainWindow.loadFile(rendererEntry);
  }
  // In development, a renderer failure can prevent ready-to-show from firing
  // and leave a hidden process with no visible window. Loading has completed
  // at this point, so show the shell deterministically.
  mainWindow.show();
}

app.whenReady().then(async () => {
  await initializeDatabase();
  startApi();
  ipcMain.handle('opcai:pick-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('opcai:pick-project-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择项目空间目录', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('opcai:create-project-workspace', (_, value) => createProjectWorkspace(value));
  ipcMain.handle('opcai:list-project-files', (_, root) => listProjectFiles(root));
  ipcMain.handle('opcai:read-project-file', (_, root, relative) => readProjectFile(root, relative));
  ipcMain.handle('opcai:write-project-file', (_, root, relative, content) => writeProjectFile(root, relative, content));
  ipcMain.handle('opcai:sync-project-workspace', (_, root, runId) => syncRunWorkspaceToProject(root, runId));
  ipcMain.handle('opcai:materialize-project-assets', (_, root, assetIds) => materializeProjectAssets(root, assetIds));
  ipcMain.handle('opcai:pick-skill', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose SKILL.md', filters: [{ name: 'Agent Skill manifest', extensions: ['md'] }], properties: ['openFile'] });
    return result.canceled ? null : readSkillManifest(result.filePaths[0]);
  });
  ipcMain.handle('opcai:create-skill', (_, value) => {
    const name = safeSkillName(value?.name);
    const description = String(value?.description || '').trim().slice(0, 500);
    if (!name || !description) throw new Error('A skill name and description are required.');
    const folder = path.join(storageRoot(), 'skills', name);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, 'SKILL.md');
    if (existsSync(file)) throw new Error('A local skill with this name already exists.');
    writeFileSync(file, `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n\n# ${name}\n\n## Instructions\n\nDescribe when the agent should use this skill and the safe workflow to follow.\n\n## References\n\nPlace optional reference material in this folder and load it only when needed.\n`, { mode: 0o600 });
    return readSkillManifest(file);
  });
  ipcMain.handle('opcai:write-skill-draft', (_, value) => writeSkillDraft(value));
  ipcMain.handle('opcai:read-skill-draft', (_, file) => readSkillDraft(file));
  ipcMain.handle('opcai:list-skill-files', (_, file) => listSkillFiles(file));
  ipcMain.handle('opcai:read-skill-file', (_, file) => readManagedSkillFile(file));
  ipcMain.handle('opcai:write-skill-file', (_, file, content) => writeManagedSkillFile(file, content));
  ipcMain.handle('opcai:delete-managed-skill', (_, file) => deleteManagedSkill(file));
  ipcMain.handle('opcai:install-skill', async (_, reference) => runSkillsCli(reference));
  ipcMain.handle('opcai:import-git-skill', async (_, url) => importGitSkillRepository(url));
  ipcMain.handle('opcai:find-skills', async (_, query, batchCount) => findSkills(query, batchCount));
  ipcMain.handle('opcai:open-external', (_, value) => shell.openExternal(String(value)));
  ipcMain.handle('opcai:get-model-config', () => readModelConfig());
  ipcMain.handle('opcai:save-model-config', (_, value) => writeModelConfig(value));
  ipcMain.handle('opcai:list-ollama-models', async (_, baseUrl) => {
    const root = String(baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
    const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Ollama 返回 ${response.status}`);
    const payload = await response.json();
    return (payload.models ?? []).map((item) => String(item.name || '')).filter(Boolean);
  });
  ipcMain.handle('opcai:pull-ollama-model', async (_, baseUrl, modelName) => {
    const root = String(baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
    const name = String(modelName || '').trim();
    if (!name) throw new Error('缺少模型名称');
    const response = await fetch(`${root}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: false }),
      signal: AbortSignal.timeout(900000),
    });
    if (!response.ok) throw new Error(`Ollama 拉取失败 ${response.status}`);
    const payload = await response.json();
    return String(payload.status || 'success');
  });
  ipcMain.handle('opcai:storage-get', (_, key) => getStoredValue(String(key)));
  ipcMain.handle('opcai:storage-set', (_, key, value) => { setStoredValue(String(key), String(value)); });
  ipcMain.handle('opcai:list-assets', () => listAssets());
  ipcMain.handle('opcai:archive-artifact', (_, value) => archiveArtifact(value));
  ipcMain.handle('opcai:save-asset', async (_, assetId) => {
    const { row, target } = assetFile(assetId);
    const result = await dialog.showSaveDialog(mainWindow, { title: '下载资产', defaultPath: row.name });
    if (result.canceled || !result.filePath) return false;
    copyFileSync(target, result.filePath);
    return true;
  });
  ipcMain.handle('opcai:reveal-asset', (_, assetId) => { const { target } = assetFile(assetId); shell.showItemInFolder(target); });
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => apiProcess?.kill('SIGTERM'));
