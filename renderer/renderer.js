const state = { pages: [], selected: null };

const el = (id) => document.getElementById(id);

// --- バージョン表示 / テーマ / 更新確認 ---
let currentVersion = '0.0.0';
window.appInfo.getVersion().then((v) => {
  currentVersion = v;
  el('versionInfo').textContent = `v${v}`;
});

const THEME_KEY = 'ymb-html-sync-theme';
function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  el('themeToggle').checked = dark;
}
applyTheme(localStorage.getItem(THEME_KEY) === 'dark');
el('themeToggle').addEventListener('change', (e) => {
  applyTheme(e.target.checked);
  localStorage.setItem(THEME_KEY, e.target.checked ? 'dark' : 'light');
});

function parseVersion(v) {
  return v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}
function isNewer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

el('checkUpdateBtn').addEventListener('click', async () => {
  const result = el('updateResult');
  if (!window.appInfo.updateRepo) {
    result.textContent = 'リポジトリ未設定(GitHub公開後に設定します)';
    return;
  }
  result.textContent = '確認中…';
  try {
    const res = await fetch(`https://api.github.com/repos/${window.appInfo.updateRepo}/releases/latest`);
    if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
    const data = await res.json();
    const latest = parseVersion(data.tag_name || '0.0.0');
    const current = parseVersion(currentVersion);
    if (isNewer(latest, current)) {
      result.textContent = `新しいバージョンあります: ${data.tag_name}(現在: v${currentVersion})`;
    } else {
      result.textContent = '最新版です';
    }
  } catch (e) {
    result.textContent = `確認失敗: ${e.message}`;
  }
});

// --- 左一覧の幅をドラッグで可変に ---
const LIST_WIDTH_KEY = 'ymb-html-sync-list-width';
const LIST_WIDTH_DEFAULT = 420;
const LIST_WIDTH_MIN = 240;
function clampListWidth(width) {
  const max = Math.max(LIST_WIDTH_MIN, window.innerWidth - 400);
  return Math.min(Math.max(width, LIST_WIDTH_MIN), max);
}
function setListWidth(width) {
  el('pageList').style.width = `${clampListWidth(width)}px`;
}
function restoreListWidth() {
  const saved = parseInt(localStorage.getItem(LIST_WIDTH_KEY), 10);
  setListWidth(Number.isFinite(saved) && saved > 0 ? saved : LIST_WIDTH_DEFAULT);
}
restoreListWidth();

(() => {
  const splitter = el('splitter');
  let dragging = false;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const listRect = el('pageList').getBoundingClientRect();
    setListWidth(e.clientX - listRect.left);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
    const width = parseInt(el('pageList').style.width, 10);
    if (Number.isFinite(width)) localStorage.setItem(LIST_WIDTH_KEY, String(width));
  });

  splitter.addEventListener('dblclick', () => {
    setListWidth(LIST_WIDTH_DEFAULT);
    localStorage.setItem(LIST_WIDTH_KEY, String(LIST_WIDTH_DEFAULT));
  });
})();

// --- 入力値の記憶(ローカルルート/公開サーバーURL/対象サブディレクトリ/Basic認証ユーザー名) ---
// basicPassは平文保存を避けるため保存しない。
const PATHS_KEY = 'ymb-html-sync-paths';
function restorePaths() {
  try {
    const saved = JSON.parse(localStorage.getItem(PATHS_KEY) || '{}');
    if (saved.localRoot) el('localRoot').value = saved.localRoot;
    if (saved.baseUrl) el('baseUrl').value = saved.baseUrl;
    if (saved.scope) el('scope').value = saved.scope;
    if (saved.basicUser) el('basicUser').value = saved.basicUser;
  } catch {
    // 保存値が壊れている場合は無視して初期状態のまま
  }
}
function savePaths() {
  localStorage.setItem(PATHS_KEY, JSON.stringify({
    localRoot: el('localRoot').value.trim(),
    baseUrl: el('baseUrl').value.trim(),
    scope: el('scope').value.trim(),
    basicUser: el('basicUser').value.trim(),
    // basicPassは絶対に保存しない(平文保存を避ける)
  }));
}
restorePaths();

el('pickLocalRoot').addEventListener('click', async () => {
  const p = await window.api.selectFolder(el('localRoot').value);
  if (p) el('localRoot').value = p;
});

// --- リンククロール(新規ページ探索)のON/OFFを記憶する。デフォルトはON。 ---
const CRAWL_LINKS_KEY = 'ymb-html-sync-crawl-links';
function restoreCrawlLinks() {
  const saved = localStorage.getItem(CRAWL_LINKS_KEY);
  el('crawlLinks').checked = saved === null ? true : saved === 'true';
}
restoreCrawlLinks();
el('crawlLinks').addEventListener('change', (e) => {
  localStorage.setItem(CRAWL_LINKS_KEY, e.target.checked ? 'true' : 'false');
});

// --- スキャン実行 ---
function updateSyncAllBtn() {
  const btn = el('syncAllBtn');
  const diffCount = state.pages.filter((p) => p.status === 'diff').length;
  const newCount = state.pages.filter((p) => p.status === 'server-only').length;
  const includeNew = el('includeNew').checked;
  const total = diffCount + (includeNew ? newCount : 0);
  btn.disabled = total === 0;
  btn.textContent = total > 0
    ? `差分ページ全部をサーバー版で上書き (${total}件)`
    : '差分ページ全部をサーバー版で上書き';
}
el('includeNew').addEventListener('change', updateSyncAllBtn);

el('runScan').addEventListener('click', async () => {
  const localRoot = el('localRoot').value.trim();
  const baseUrl = el('baseUrl').value.trim();
  const basicUser = el('basicUser').value.trim();
  const basicPass = el('basicPass').value;
  const scope = el('scope').value.trim();
  const crawl = el('crawlLinks').checked;

  if (!localRoot || !baseUrl) {
    el('scanStatus').textContent = 'ローカルHTMLルートと公開サーバーURLを指定してください';
    return;
  }

  savePaths();
  el('scanStatus').textContent = 'スキャン中…';
  el('runScan').disabled = true;

  try {
    const res = await window.api.scan({ localRoot, baseUrl, basicUser, basicPass, scope, crawl });
    if (!res.ok) {
      el('scanStatus').textContent = `エラー: ${res.error}`;
      return;
    }
    state.pages = res.pages;
    state.selected = null;
    renderPageList();
    renderDetail(null);
    updateSyncAllBtn();

    const diffCount = res.pages.filter((p) => p.status === 'diff').length;
    const errorCount = res.pages.filter((p) => p.status === 'error').length;
    const newCount = res.pages.filter((p) => p.status === 'server-only').length;
    let msg = `完了: ${res.pages.length}ページ(差分${diffCount} / 新規${newCount} / エラー${errorCount})`;
    if (res.sitemapNote) msg += ` ${res.sitemapNote}`;
    el('scanStatus').textContent = msg;
  } catch (e) {
    el('scanStatus').textContent = `エラー: ${e.message}`;
  } finally {
    el('runScan').disabled = false;
  }
});

el('syncAllBtn').addEventListener('click', async () => {
  const includeNew = el('includeNew').checked;
  const diffCount = state.pages.filter((p) => p.status === 'diff').length;
  const newCount = state.pages.filter((p) => p.status === 'server-only').length;
  const total = diffCount + (includeNew ? newCount : 0);
  if (total === 0) return;

  const confirmMsg = includeNew
    ? `差分${diffCount}件・新規${newCount}件、合計${total}ページをサーバー版で上書き(または新規保存)します。よろしいですか?`
    : `差分のある${diffCount}ページをサーバー版で上書きします。よろしいですか?`;
  if (!window.confirm(confirmMsg)) return;

  el('scanStatus').textContent = '一括同期中…';
  try {
    const res = await window.api.syncAll(includeNew);
    if (!res.ok) {
      el('scanStatus').textContent = '一括同期に失敗しました';
      return;
    }
    state.pages = res.pages;
    const successCount = res.results.filter((r) => r.ok).length;
    const failCount = res.results.filter((r) => !r.ok).length;
    el('scanStatus').textContent = `一括同期完了: 成功 ${successCount}件 / 失敗 ${failCount}件`;
    renderPageList();
    updateSyncAllBtn();
    if (state.selected) {
      const page = state.pages.find((p) => p.relPath === state.selected);
      renderDetail(page || null);
    }
  } catch (e) {
    el('scanStatus').textContent = `一括同期エラー: ${e.message}`;
  }
});

// --- 一覧描画 ---
function badgeHtml(status) {
  switch (status) {
    case 'identical': return '<span class="badge identical">一致</span>';
    case 'diff': return '<span class="badge diff">差分</span>';
    case 'error': return '<span class="badge error">エラー</span>';
    case 'server-only': return '<span class="badge server-only">新規(サーバーのみ)</span>';
    default: return '';
  }
}

function renderPageList() {
  const body = el('pageListBody');
  body.innerHTML = '';
  for (const page of state.pages) {
    const tr = document.createElement('tr');
    tr.className = 'row' + (state.selected === page.relPath ? ' selected' : '');
    tr.innerHTML = `
      <td>${escapeForDisplay(page.relPath)}</td>
      <td>${badgeHtml(page.status)}</td>
    `;
    tr.addEventListener('click', () => {
      state.selected = page.relPath;
      renderPageList();
      renderDetail(page);
    });
    body.appendChild(tr);
  }
}

// innerHTML / 属性へ差し込む文字列は全部これを通す。
// パスやURLはユーザーが指定した値・サーバーの応答由来の値のため通常は安全だが、
// 万一クォートやタグを含む文字列があってもDOM注入(→window.api経由の任意ファイル操作)に
// つながらないよう常にエスケープする。
function escapeForDisplay(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// charDiffのセグメント配列から、side('local'|'server')に応じたHTML断片を組み立てる。
function buildCharDiffHtml(charDiff, side) {
  let out = '';
  for (const part of charDiff) {
    if (side === 'server') {
      // サーバー側: ローカルからは消える(removed)分は表示せず、追加分(added)を強調
      if (part.removed) continue;
      out += part.added ? `<span class="char-added">${escapeForDisplay(part.value)}</span>` : escapeForDisplay(part.value);
    } else {
      // ローカル側: サーバーにしかない(added)分は表示せず、消える分(removed)を強調
      if (part.added) continue;
      out += part.removed ? `<span class="char-removed">${escapeForDisplay(part.value)}</span>` : escapeForDisplay(part.value);
    }
  }
  return out;
}

function buildHunkCardHtml(hunk) {
  const localHtml = hunk.charDiff ? buildCharDiffHtml(hunk.charDiff, 'local') : escapeForDisplay(hunk.removedText);
  const serverHtml = hunk.charDiff ? buildCharDiffHtml(hunk.charDiff, 'server') : escapeForDisplay(hunk.addedText);
  return `
    <div class="hunk-block hunk-block-server"><span class="hunk-block-label">サーバー(最新)</span>${serverHtml}</div>
    <div class="hunk-block hunk-block-local"><span class="hunk-block-label">ローカル(現状)</span>${localHtml}</div>
  `;
}

function renderDetail(page) {
  const detail = el('detail');
  if (!page) {
    detail.innerHTML = '<p class="placeholder">左の一覧からページを選択してください。</p>';
    return;
  }

  const pathPairHtml = `
    <div class="path-pair">
      <div class="path-box server">
        <div class="path-label">公開サーバー(取得元)</div>
        <div class="path-value">${escapeForDisplay(page.url)}</div>
      </div>
      <div class="path-arrow" title="サーバー側の内容でローカルを上書きします">サーバー → ローカル</div>
      <div class="path-box local">
        <div class="path-label">ローカル(上書き先)</div>
        <div class="path-value">${escapeForDisplay(page.localPath)}</div>
        <button class="openBtn" data-path="${escapeForDisplay(page.localPath)}">フォルダを開く</button>
      </div>
    </div>
  `;

  if (page.status === 'error') {
    detail.innerHTML = `
      <h2>${escapeForDisplay(page.relPath)}</h2>
      ${pathPairHtml}
      <p class="message error">取得エラー: ${escapeForDisplay(page.error || '不明なエラー')}</p>
    `;
    bindOpenButtons(detail);
    return;
  }

  if (page.status === 'identical') {
    detail.innerHTML = `
      <h2>${escapeForDisplay(page.relPath)}</h2>
      ${pathPairHtml}
      <p class="message">差分なし。ローカルとサーバーの内容は一致しています。</p>
      <div class="actions"><button id="restoreBackupBtn" class="secondary">バックアップ(.bak)から復元</button></div>
    `;
    bindOpenButtons(detail);
    bindRestoreButton(detail, page);
    return;
  }

  if (page.status === 'server-only') {
    detail.innerHTML = `
      <h2>${escapeForDisplay(page.relPath)}</h2>
      ${pathPairHtml}
      <p class="message">ローカルに存在しない新規ページです(サーバーのsitemap.xmlから検出)。</p>
      <div class="actions"><button id="syncOneBtn">ローカルに保存</button></div>
    `;
    bindOpenButtons(detail);
    bindSyncOneButton(detail, page, 'ローカルに保存しました。');
    return;
  }

  // status === 'diff'
  let bodyHtml = '';
  if (page.tooLargeForLineDiff) {
    bodyHtml = `
      <p class="message">差分あり(ファイルが大きいため詳細比較は省略しました)。先頭部分のみ表示します。</p>
      <div class="hunk-card">
        <div class="hunk-block hunk-block-server"><span class="hunk-block-label">サーバー(先頭500文字)</span>${escapeForDisplay(page.remotePreview || '')}</div>
        <div class="hunk-block hunk-block-local"><span class="hunk-block-label">ローカル(先頭500文字)</span>${escapeForDisplay(page.localPreview || '')}</div>
      </div>
    `;
  } else if (!page.hunks || page.hunks.length === 0) {
    bodyHtml = '<p class="message">差分がありますが、表示可能な変更箇所は検出されませんでした。</p>';
  } else {
    bodyHtml = page.hunks.map((h) => `<div class="hunk-card">${buildHunkCardHtml(h)}</div>`).join('');
  }

  detail.innerHTML = `
    <h2>${escapeForDisplay(page.relPath)}</h2>
    ${pathPairHtml}
    <div class="actions"><button id="syncOneBtn">このページをサーバー版で上書き</button></div>
    ${bodyHtml}
  `;
  bindOpenButtons(detail);
  bindSyncOneButton(detail, page, 'サーバー版で上書きしました。');
}

function bindOpenButtons(detail) {
  detail.querySelectorAll('.openBtn').forEach((btn) => {
    btn.addEventListener('click', () => window.api.openPath(btn.dataset.path));
  });
}

function applyUpdatedPage(updatedPage) {
  if (!updatedPage) return;
  const idx = state.pages.findIndex((p) => p.relPath === updatedPage.relPath);
  if (idx !== -1) state.pages[idx] = updatedPage;
  else state.pages.push(updatedPage);
  renderPageList();
  updateSyncAllBtn();
}

function bindSyncOneButton(detail, page, successMessage) {
  const btn = detail.querySelector('#syncOneBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const res = await window.api.syncPage(page.relPath);
    if (!res.ok) {
      alert(`同期に失敗しました: ${res.error || ''}`);
      btn.disabled = false;
      return;
    }
    applyUpdatedPage(res.updatedPage);
    el('scanStatus').textContent = `${page.relPath}: ${successMessage}`;
    if (state.selected === page.relPath) renderDetail(res.updatedPage);
  });
}

function bindRestoreButton(detail, page) {
  const btn = detail.querySelector('#restoreBackupBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!window.confirm(`${page.relPath} をバックアップ(.bak)から復元します。よろしいですか?`)) return;
    const res = await window.api.restoreBackup(page.relPath);
    if (!res.ok) {
      alert(`復元に失敗しました: ${res.error || ''}`);
      return;
    }
    applyUpdatedPage(res.updatedPage);
    el('scanStatus').textContent = `${page.relPath}: バックアップから復元しました。`;
    if (state.selected === page.relPath) renderDetail(res.updatedPage);
  });
}
