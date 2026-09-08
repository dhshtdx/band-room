import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import net from 'node:net';

const preferredPort = 4173;
let mainWindow = null;
let serverModule = null;
let serverStopped = false;
let shutdownStarted = false;

function reserveAvailablePort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(null));
    probe.listen(port, '0.0.0.0', () => {
      const address = probe.address();
      const availablePort = typeof address === 'object' && address ? address.port : null;
      probe.close(() => resolve(availablePort));
    });
  });
}

async function choosePort() {
  return (await reserveAvailablePort(preferredPort)) ?? (await reserveAvailablePort(0));
}

function installApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Band Room',
      submenu: [
        { role: 'about', label: '关于 Band Room' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 Band Room' },
        { role: 'hideOthers', label: '隐藏其他应用' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Band Room' }
      ]
    },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { role: 'front', label: '前置全部窗口' }] }
  ]));
}

function showFatalError(title, error) {
  const detail = error instanceof Error ? `${error.message}\n\n${error.stack || ''}` : String(error);
  dialog.showErrorBox(title, `${detail}\n\n请退出 Band Room 后重新打开；若仍失败，请保存此窗口截图。`);
}

async function startServer() {
  const port = await choosePort();
  if (!port) throw new Error('没有可用的本地网络端口。');
  process.env.PORT = String(port);
  process.env.BAND_ROOM_DATA_DIR = app.getPath('userData');
  serverModule = await import('../server/index.js');
  return serverModule.serverReady;
}

async function createMainWindow(port) {
  const localOrigin = `http://127.0.0.1:${port}`;
  const window = new BrowserWindow({
    title: 'Band Room · 乐队排练辅助系统',
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 680,
    show: false,
    backgroundColor: '#111827',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  window.center();
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(localOrigin)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(localOrigin)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    showFatalError('Band Room 页面意外停止', new Error(`渲染进程状态：${details.reason}`));
  });
  await window.loadURL(`${localOrigin}/host`);
  return window;
}

async function shutdownServer() {
  if (serverStopped) return;
  serverStopped = true;
  await serverModule?.stopBandRoomServer?.();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAboutPanelOptions({
      applicationName: 'Band Room',
      applicationVersion: app.getVersion(),
      copyright: '乐队排练辅助系统'
    });
    installApplicationMenu();
    try {
      const { port } = await startServer();
      mainWindow = await createMainWindow(port);
    } catch (error) {
      showFatalError('Band Room 启动失败', error);
      await shutdownServer();
      app.quit();
    }
  });

  app.on('activate', async () => {
    if (mainWindow || !serverModule) return;
    try {
      const { port } = await serverModule.serverReady;
      mainWindow = await createMainWindow(port);
    } catch (error) {
      showFatalError('Band Room 窗口打开失败', error);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (serverStopped || shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    shutdownServer().finally(() => app.quit());
  });
}
