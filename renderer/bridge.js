// Tauri の画面側の橋渡し。Electron 版の preload.js(window.api / window.appInfo)と、同じ形で提供する。
// 画面(renderer.js)は、Electron 版のまま変えずに動く。
// 重い処理(差分・走査の手順)は、必要になったときに、ES モジュールを読み込む。
(function () {
  const { invoke } = window.__TAURI__.core;
  const UPDATE_REPO = 'yumebi/ymb_html_synch';
  const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;

  // Rust のコマンドを、コア処理の `io` の形にする。
  const io = {
    setRoot: (root) => invoke('set_root', { path: root }),
    listHtml: (startRel) => invoke('list_html', { startRel }),
    localPath: (rel) => invoke('local_path', { rel }),
    readLocal: (rel) => invoke('read_local', { rel }),
    writeLocal: (rel, text, backup) => invoke('write_local', { rel, text, backup }),
    restoreLocal: (rel) => invoke('restore_local', { rel }),
    fetchText: (url, auth, timeoutMs, maxBytes) =>
      invoke('fetch_text', { url, auth: auth || null, timeoutMs, maxBytes }),
  };

  let syncPromise = null;
  function getSync() {
    if (!syncPromise) {
      syncPromise = import('./core/htmlSync.js').then((m) => m.createSync(io));
    }
    return syncPromise;
  }

  function relFromLocalPath(localPath, pages) {
    const hit = pages.find((p) => p.localPath === localPath);
    return hit ? hit.relPath : null;
  }

  window.api = {
    selectFolder: async (defaultPath) => {
      const picked = await window.__TAURI__.dialog.open({
        directory: true,
        multiple: false,
        defaultPath: defaultPath || undefined,
      });
      return typeof picked === 'string' ? picked : null;
    },
    scan: async (args) => {
      try {
        const sync = await getSync();
        const { pages, sitemapNote } = await sync.scanSite(args);
        return { ok: true, pages, sitemapNote };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },
    syncPage: async (relPath) => (await getSync()).syncPage(relPath),
    syncAll: async (includeNew) => (await getSync()).syncAll(!!includeNew),
    restoreBackup: async (relPath) => (await getSync()).restoreBackup(relPath),
    // 引数は、スキャン結果の localPath(絶対パス)。ルートの中の相対パスに直してから、Rust に渡す。
    openPath: async (localPath) => {
      const sync = await getSync();
      const rel = relFromLocalPath(localPath, sync.getPages());
      if (rel) await invoke('reveal', { rel });
    },
  };

  // 確認・警告のダイアログ。ブラウザ標準の confirm / alert は、macOS の WKWebView では動かないことがあるため、
  // OS 標準のダイアログ(Tauri の dialog プラグイン)を使う。どの OS でも、同じように動く。
  window.ymbDialog = {
    confirm: (message) =>
      window.__TAURI__.dialog.ask(message, {
        title: 'YMB HTML差分同期ツール',
        kind: 'warning',
        okLabel: 'はい',
        cancelLabel: 'いいえ',
      }),
    alert: (message) =>
      window.__TAURI__.dialog.message(message, { title: 'YMB HTML差分同期ツール', kind: 'error' }),
  };

  window.appInfo = {
    getVersion: () => invoke('app_version'),
    updateRepo: UPDATE_REPO,
  };

  // 起動時の更新確認。ネットワーク不通などでは、黙って何もしない。
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
      const current = await invoke('app_version');
      if (!isNewer(parseVersion(data.tag_name || '0.0.0'), parseVersion(current))) return;
      const open = await window.__TAURI__.dialog.ask(
        `新しいバージョン ${data.tag_name} が公開されています(現在: v${current})\nリポジトリのReleasesページからダウンロードできます。`,
        { title: '新しいバージョンがあります', kind: 'info', okLabel: 'リポジトリを開く', cancelLabel: '閉じる' },
      );
      if (open) await window.__TAURI__.opener.openUrl(RELEASES_URL);
    } catch (e) {
      // 起動時チェックは、失敗しても黙って無視する
    }
  }
  window.addEventListener('load', () => {
    checkForUpdateOnStartup();
  });
})();
