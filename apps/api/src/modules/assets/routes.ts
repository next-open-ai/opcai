import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { FastifyPluginAsync } from 'fastify';

const require = createRequire(__filename);

type SqlDatabase = {
  exec: (sql: string, params?: unknown[]) => Array<{ values?: unknown[][] }>;
  run: (sql: string, params?: unknown[]) => void;
  export: () => Uint8Array;
};

let databasePromise: Promise<SqlDatabase> | null = null;

function dataDir(): string {
  return process.env.OPCAI_DATA_DIR || path.join(os.homedir(), '.opcai');
}

function databaseFile() {
  return path.join(dataDir(), 'opcai.sqlite');
}

async function database(): Promise<SqlDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
      const sqlJsRoot = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
      const initSqlJs = require(path.join(sqlJsRoot, 'sql-wasm.js'));
      const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(sqlJsRoot, 'sql-wasm.wasm')) });
      const db = new SQL.Database(fs.existsSync(databaseFile()) ? fs.readFileSync(databaseFile()) : undefined) as SqlDatabase;
      db.run('CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, conversation_id TEXT, employee_id TEXT, run_id TEXT NOT NULL, sha256 TEXT NOT NULL)');
      db.run('CREATE INDEX IF NOT EXISTS assets_created_at ON assets(created_at DESC)');
      const cols = new Set((db.exec('PRAGMA table_info(assets)')[0]?.values || []).map((row) => String(row[1])));
      if (!cols.has('project_id')) db.run('ALTER TABLE assets ADD COLUMN project_id TEXT');
      if (!cols.has('workspace_relative')) db.run('ALTER TABLE assets ADD COLUMN workspace_relative TEXT');
      db.run('CREATE INDEX IF NOT EXISTS assets_project_id ON assets(project_id)');
      db.run(`UPDATE assets SET workspace_relative = name WHERE workspace_relative IS NULL OR workspace_relative = ''`);
      fs.writeFileSync(databaseFile(), Buffer.from(db.export()), { mode: 0o600 });
      return db;
    })();
  }
  return databasePromise;
}

function flushDatabase(db: SqlDatabase) {
  fs.writeFileSync(databaseFile(), Buffer.from(db.export()), { mode: 0o600 });
}

function assetMimeType(name: string) {
  const extension = path.extname(name).toLowerCase();
  return ({
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.zip': 'application/zip',
  } as Record<string, string>)[extension] || 'application/octet-stream';
}

function mapAssetRow(row: unknown[]) {
  const [id, name, relativePath, mimeType, sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative] = row;
  return {
    id: String(id),
    name: String(name),
    relativePath: String(relativePath),
    mimeType: String(mimeType),
    sizeBytes: Number(sizeBytes),
    createdAt: Number(createdAt),
    conversationId: conversationId ? String(conversationId) : null,
    employeeId: employeeId ? String(employeeId) : null,
    runId: String(runId),
    sha256: String(sha256),
    projectId: projectId ? String(projectId) : null,
    workspaceRelative: workspaceRelative ? String(workspaceRelative) : String(name),
  };
}

function assetRows(result: Array<{ values?: unknown[][] }>) {
  return (result[0]?.values || []).map((row) => mapAssetRow(row));
}

const ASSET_SELECT = 'SELECT id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256, project_id, workspace_relative FROM assets';

async function listAssets() {
  const db = await database();
  return assetRows(db.exec(`${ASSET_SELECT} ORDER BY created_at DESC`));
}

async function assetFile(assetId: string) {
  const db = await database();
  const row = assetRows(db.exec(`${ASSET_SELECT} WHERE id = ?`, [String(assetId)]))[0];
  if (!row) throw new Error('Asset not found.');
  const target = path.resolve(dataDir(), row.relativePath);
  if (!target.startsWith(`${path.resolve(dataDir(), 'assets')}${path.sep}`) || !fs.existsSync(target)) {
    throw new Error('Asset file is unavailable.');
  }
  return { row, target, db };
}

async function archiveArtifact(value: { runId?: string; relativePath?: string; conversationId?: string; employeeId?: string; projectId?: string }) {
  const runId = String(value?.runId || '');
  const relativePath = String(value?.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/^[a-f0-9-]{20,}$/i.test(runId) || !relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid artifact location.');
  }
  const processDirs = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);
  const neverExt = new Set(['pyc', 'pyo', 'pyd', 'class', 'o', 'obj', 'exe', 'dll', 'so', 'dylib', 'map']);
  const parts = relativePath.split('/');
  const base = parts[parts.length - 1] || '';
  const ext = path.extname(base).slice(1).toLowerCase();
  if (parts[0] !== 'output' || parts.length < 2 || parts.some((part) => processDirs.has(part)) || !ext || neverExt.has(ext) || (base.startsWith('.') && base !== '.gitkeep')) {
    throw new Error('Only business deliverables under output/ can be archived to the asset library.');
  }
  const workspaceRoot = path.resolve(dataDir(), 'workspaces', runId);
  const source = path.resolve(workspaceRoot, relativePath);
  if (!source.startsWith(`${workspaceRoot}${path.sep}`) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error('Generated artifact is no longer available.');
  }
  const db = await database();
  const name = path.basename(source);
  const sizeBytes = fs.statSync(source).size;
  if (sizeBytes > 100 * 1024 * 1024) throw new Error('Generated artifact exceeds the 100 MB asset limit.');
  const sha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const existing = assetRows(db.exec(`${ASSET_SELECT} WHERE run_id = ? AND workspace_relative = ? AND sha256 = ? LIMIT 1`, [runId, relativePath, sha256]))[0];
  if (existing) return existing;
  const id = randomUUID();
  const targetFolder = path.join(dataDir(), 'assets', id);
  fs.mkdirSync(targetFolder, { recursive: true, mode: 0o700 });
  const target = path.join(targetFolder, name);
  fs.copyFileSync(source, target, 0);
  const relativeAssetPath = path.relative(dataDir(), target).split(path.sep).join('/');
  const createdAt = Date.now();
  const projectId = String(value?.projectId || '').trim() || null;
  const conversationId = String(value?.conversationId || '') || null;
  const employeeId = String(value?.employeeId || '') || null;
  db.run(
    'INSERT INTO assets (id, name, relative_path, mime_type, size_bytes, created_at, conversation_id, employee_id, run_id, sha256, project_id, workspace_relative) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, relativeAssetPath, assetMimeType(name), sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, relativePath],
  );
  flushDatabase(db);
  return { id, name, relativePath: relativeAssetPath, mimeType: assetMimeType(name), sizeBytes, createdAt, conversationId, employeeId, runId, sha256, projectId, workspaceRelative: relativePath };
}

async function linkAssetsToProject(value: { projectId?: string; assetIds?: string[]; workspacePath?: string }) {
  const db = await database();
  const projectId = String(value?.projectId || '').trim();
  const assetIds = Array.isArray(value?.assetIds) ? value.assetIds.map((id) => String(id || '')).filter(Boolean) : [];
  if (!projectId) throw new Error('projectId is required.');
  if (!assetIds.length) return { updated: 0, copied: 0, projectId };
  let updated = 0;
  for (const assetId of assetIds) {
    db.run('UPDATE assets SET project_id = ? WHERE id = ?', [projectId, assetId]);
    updated += 1;
  }
  flushDatabase(db);
  let copied = 0;
  const workspacePath = String(value?.workspacePath || '').trim();
  if (workspacePath) {
    const root = path.resolve(workspacePath);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const assetId of assetIds) {
      try {
        const { row, target: source } = await assetFile(assetId);
        const relative = String(row.workspaceRelative || row.name).replace(/\\/g, '/').replace(/^\/+/, '');
        if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) continue;
        const dest = path.resolve(root, relative);
        if (!dest.startsWith(`${root}${path.sep}`)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, dest, 0);
        copied += 1;
      } catch {
        /* Keep linking even if one file copy fails. */
      }
    }
  }
  return { updated, copied, projectId };
}

async function unlinkAssetsFromProject(assetIds: string[]) {
  const db = await database();
  const ids = Array.isArray(assetIds) ? assetIds.map((id) => String(id || '')).filter(Boolean) : [];
  let updated = 0;
  for (const assetId of ids) {
    db.run('UPDATE assets SET project_id = NULL WHERE id = ?', [assetId]);
    updated += 1;
  }
  flushDatabase(db);
  return { updated };
}

function previewBinaryLimit(name: string) {
  if (/\.pdf$/i.test(name)) return 40 * 1024 * 1024;
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name) ? 12 * 1024 * 1024 : 2 * 1024 * 1024;
}

async function readAssetPreview(assetId: string) {
  const { row, target } = await assetFile(assetId);
  const size = fs.statSync(target).size;
  if (size > previewBinaryLimit(row.name)) throw new Error('File is too large to preview.');
  const textLike = /\.(md|markdown|txt|html?|css|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|xml|svg|csv)$/i.test(row.name);
  if (textLike) {
    return { kind: 'text' as const, name: row.name, mimeType: row.mimeType, content: fs.readFileSync(target, 'utf8'), bytes: size };
  }
  return { kind: 'binary' as const, name: row.name, mimeType: row.mimeType, base64: fs.readFileSync(target).toString('base64'), bytes: size };
}

async function assetContent(assetId: string) {
  const { row, target } = await assetFile(assetId);
  return { row, target };
}

export const assetRoutes: FastifyPluginAsync = async (app) => {
  app.get('/assets', async () => listAssets());

  app.post('/assets/archive', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      return await archiveArtifact({
        runId: typeof body.runId === 'string' ? body.runId : undefined,
        relativePath: typeof body.relativePath === 'string' ? body.relativePath : undefined,
        conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
        employeeId: typeof body.employeeId === 'string' ? body.employeeId : undefined,
        projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/assets/link', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      return await linkAssetsToProject({
        projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
        assetIds: Array.isArray(body.assetIds) ? body.assetIds.map((id) => String(id || '')) : [],
        workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
      });
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/assets/unlink', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    try {
      return await unlinkAssetsFromProject(Array.isArray(body.assetIds) ? body.assetIds.map((id) => String(id || '')) : []);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/assets/preview', async (request, reply) => {
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      return await readAssetPreview(String(query.assetId || ''));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/assets/content', async (request, reply) => {
    const query = request.query && typeof request.query === 'object' ? (request.query as Record<string, unknown>) : {};
    try {
      const { row, target } = await assetContent(String(query.assetId || ''));
      reply.header('content-type', row.mimeType || 'application/octet-stream');
      reply.header('content-disposition', String(query.download || '') === '1' ? `attachment; filename="${encodeURIComponent(row.name)}"` : `inline; filename="${encodeURIComponent(row.name)}"`);
      return reply.send(fs.createReadStream(target));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });
};
