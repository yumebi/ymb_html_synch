const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: (defaultPath) => ipcRenderer.invoke('select-folder', defaultPath),
  scan: (args) => ipcRenderer.invoke('scan', args),
  syncPage: (relPath) => ipcRenderer.invoke('sync-page', { relPath }),
  syncAll: (includeNew) => ipcRenderer.invoke('sync-all', { includeNew }),
  restoreBackup: (relPath) => ipcRenderer.invoke('restore-backup', { relPath }),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
});

contextBridge.exposeInMainWorld('appInfo', {
  // sandbox化されたpreloadではローカルファイルのrequireが使えないため、
  // バージョンはIPC経由でメインプロセス(app.getVersion())から取得する
  getVersion: () => ipcRenderer.invoke('get-version'),
  updateRepo: 'yumebi/ymb_html_synch',
});
