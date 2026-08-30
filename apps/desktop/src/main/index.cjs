const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');

const apiPort = Number(process.env.OPCAI_API_PORT || 4318);
let mainWindow;
let apiProcess;

function apiEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'api', 'main.js')
    : path.resolve(__dirname, '../../../api/dist/main.js');
}

function startApi() {
  apiProcess = fork(apiEntry(), [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPCAI_API_PORT: String(apiPort),
      // The API is unpacked under Resources while its production dependencies
      // remain inside app.asar. This makes Node's resolver explicit.
      ...(app.isPackaged ? { NODE_PATH: path.join(app.getAppPath(), 'node_modules') } : {}),
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const rendererUrl = process.env.OPCAI_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else {
    const rendererEntry = app.isPackaged
      ? path.join(app.getAppPath(), '.stage', 'renderer', 'index.html')
      : path.resolve(__dirname, '../../../renderer/dist/index.html');
    await mainWindow.loadFile(rendererEntry);
  }
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(async () => {
  startApi();
  ipcMain.handle('opcai:pick-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('opcai:open-external', (_, value) => shell.openExternal(String(value)));
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => apiProcess?.kill('SIGTERM'));
