const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen } = require('electron');
const path = require('path');

const htmlSync = require('./src/core/htmlSync');
const { createWindowStateKeeper } = require('./lib/windowState');

const UPDATE_REPO = 'yumebi/ymb_html_synch';
const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;

let mainWindow;

function parseVersion(v) {
  return String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function checkForUpdateOnStartup() {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    if (!res.ok) return;
    const data = await res.json();
    const latest = parseVersion(data.tag_name || '0.0.0');
    const current = parseVersion(app.getVersion());
    if (!isNewer(latest, current)) return;

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '新しいバージョンがあります',
      message: `新しいバージョン ${data.tag_name} が公開されています(現在: v${app.getVersion()})`,
      detail: 'リポジトリのReleasesページからダウンロードできます。',
      buttons: ['リポジトリを開く', '閉じる'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) {
      shell.openExternal(RELEASES_URL);
    }
  } catch {
    // 起動時チェックはネットワーク不通等でも黙って無視する
  }
}

const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

// 位置・大きさ・最大化の状態を保存して、次回の起動で復元する。
// モニタ構成が変わって画面外になる場合は、画面内に補正される。
const windowState = createWindowStateKeeper({
  file: path.join(app.getPath('userData'), 'window-state.json'),
  defaultWidth: 1200,
  defaultHeight: 800,
  minWidth: MIN_WIDTH,
  minHeight: MIN_HEIGHT,
  screen,
});

function createWindow() {
  Menu.setApplicationMenu(null);
  const state = windowState.load();
  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // 描画が整うまで表示しない(表示した瞬間に、白い空のウインドウが見えるのを防ぐ)。
    show: false,
    backgroundColor: '#f5f6f8',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  // レンダラーからのウィンドウ生成・外部サイトへの遷移を無効化する
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  windowState.manage(mainWindow);
  mainWindow.once('ready-to-show', () => {
    // 最大化で終了していた場合は、表示する前に最大化する(通常サイズが一瞬見えるのを防ぐ)。
    if (state.isMaximized) mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.webContents.once('did-finish-load', () => {
    checkForUpdateOnStartup();
  });
}

// 二重起動を防ぐ。2つ開くと、同じフォルダに対する同期や復元を同時に実行できてしまい、互いの書き込みが
// 競合する。2つ目を起動したら、すでに開いているウインドウを前面に出す。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('select-folder', async (_evt, defaultPath) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: defaultPath || undefined,
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// ローカルHTMLフォルダと公開サーバーを比較する。コア処理はsrc/core/htmlSync.jsに分離済み
// (Electronを起動せずNodeから直接テストできるようにするため)。
ipcMain.handle('scan', async (_evt, { localRoot, baseUrl, basicUser, basicPass, scope, crawl }) => {
  try {
    const { pages, sitemapNote } = await htmlSync.scanSite({ localRoot, baseUrl, basicUser, basicPass, scope, crawl });
    return { ok: true, pages, sitemapNote };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sync-page', async (_evt, { relPath }) => {
  return htmlSync.syncPage(relPath);
});

ipcMain.handle('sync-all', async (_evt, { includeNew }) => {
  return htmlSync.syncAll(!!includeNew);
});

ipcMain.handle('restore-backup', async (_evt, { relPath }) => {
  return htmlSync.restoreBackup(relPath);
});

ipcMain.handle('open-path', async (_evt, targetPath) => {
  shell.showItemInFolder(targetPath);
});
