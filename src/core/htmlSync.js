'use strict';

/* =========================================================================
 * htmlSync.js
 * メインプロセスのコア処理(ローカル走査・リモート取得・比較・同期・復元)。
 * IPCから分離しておくことで、Electronを起動せずNodeから直接テストできる。
 * ========================================================================= */

const fs = require('fs');
const path = require('path');

const htmlDiff = require('./htmlDiff');

const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 4;

// 直近のスキャンで取得したリモートテキストを保持する(relPath -> text)。
// レンダラーへは表示用データ(hunks等)のみ渡し、巨大テキストの二重転送を避ける。
const remoteTextMap = new Map();

// 直近のスキャン結果(ページ一覧)。sync-page/sync-all/restore-backupの対象特定に使う。
let lastPages = [];
let lastScanParams = null;

function resetState() {
  remoteTextMap.clear();
  lastPages = [];
  lastScanParams = null;
}

function getPages() {
  return lastPages;
}

// ローカルフォルダ配下の*.htmlファイルを再帰的に列挙する('.'始まりは無視、'/'区切りの相対パスで返す)。
function walkHtmlFiles(rootDir) {
  const results = [];
  function walk(dir, relParts) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, [...relParts, entry.name]);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        results.push([...relParts, entry.name].join('/'));
      }
    }
  }
  if (fs.existsSync(rootDir)) walk(rootDir, []);
  return results;
}

// 簡易ワーカープール: タスク配列をlimit個の並列ワーカーで消費する。
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  }
  const workerCount = Math.min(limit, items.length);
  const runners = Array.from({ length: workerCount }, () => runner());
  await Promise.all(runners);
  return results;
}

// リモートのテキストを取得する。Basic認証・タイムアウト(15秒)・エラー種別の判定を行う。
async function fetchRemoteText(url, authHeader, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (authHeader) headers.Authorization = authHeader;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      let msg = `HTTPステータス ${res.status} が返されました`;
      if (res.status === 401) msg += '(Basic認証に失敗している可能性があります)';
      else if (res.status === 404) msg += '(サーバーにページが存在しない可能性があります)';
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('タイムアウトしました(15秒以内に応答がありませんでした)');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// origin直下とbaseUrl直下の2箇所を順に試してsitemap.xmlを取得し、<loc>のURL一覧を返す。
// 両方失敗したらnullを返す(呼び出し側でスキップ扱いにする)。
async function fetchSitemapLocs(baseUrl, authHeader) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch (e) {
    return null;
  }
  const candidates = Array.from(new Set([origin + '/sitemap.xml', htmlDiff.joinUrl(baseUrl, 'sitemap.xml')]));
  for (const url of candidates) {
    try {
      const text = await fetchRemoteText(url, authHeader, FETCH_TIMEOUT_MS);
      const locs = [];
      const re = /<loc>(.*?)<\/loc>/gi;
      let m;
      while ((m = re.exec(text)) !== null) {
        const loc = m[1].trim();
        if (loc) locs.push(loc);
      }
      return locs;
    } catch (e) {
      // 次の候補を試す
    }
  }
  return null;
}

function buildAuthHeader(basicUser, basicPass) {
  return basicUser && basicPass
    ? 'Basic ' + Buffer.from(`${basicUser}:${basicPass}`).toString('base64')
    : null;
}

function makePage(relPath, localPath, url, status, extra = {}) {
  return { relPath, localPath, url, status, ...extra };
}

// localTextとremoteTextを比較し、レンダラー表示用のページオブジェクトを組み立てる。
function buildComparedPage(relPath, localPath, url, localText, remoteText) {
  const result = htmlDiff.comparePages(localText, remoteText);
  if (result.identical) {
    return makePage(relPath, localPath, url, 'identical');
  }
  if (result.tooLargeForLineDiff) {
    return makePage(relPath, localPath, url, 'diff', {
      tooLargeForLineDiff: true,
      localPreview: localText.slice(0, 500),
      remotePreview: remoteText.slice(0, 500),
    });
  }
  return makePage(relPath, localPath, url, 'diff', { hunks: result.hunks });
}

// localRoot(+scope配下)を再帰走査して*.htmlを列挙し、公開サーバーの対応ページと比較する。
// さらにsitemap.xmlからローカルに無いページ(server-only)を検出して一覧に加える。
async function scanSite({ localRoot, baseUrl, basicUser, basicPass, scope }) {
  resetState();
  lastScanParams = { localRoot, baseUrl, basicUser, basicPass, scope };

  const authHeader = buildAuthHeader(basicUser, basicPass);
  const normalizedScope = scope ? scope.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '') : '';
  const scopeUrlPrefix = normalizedScope ? normalizedScope.split(/[\\/]+/).join('/') : '';
  const startDir = normalizedScope ? path.join(localRoot, normalizedScope) : localRoot;

  const withinScopePaths = walkHtmlFiles(startDir);
  const relPaths = withinScopePaths.map((p) => (scopeUrlPrefix ? `${scopeUrlPrefix}/${p}` : p));

  const pages = await runPool(relPaths, CONCURRENCY, async (relPath) => {
    const localPath = path.join(localRoot, ...relPath.split('/'));
    const url = htmlDiff.joinUrl(baseUrl, relPath);
    let localText;
    try {
      localText = fs.readFileSync(localPath, 'utf8');
    } catch (e) {
      return makePage(relPath, localPath, url, 'error', { error: `ローカルファイルの読み込みに失敗しました: ${e.message}` });
    }
    try {
      const remoteText = await fetchRemoteText(url, authHeader);
      remoteTextMap.set(relPath, remoteText);
      return buildComparedPage(relPath, localPath, url, localText, remoteText);
    } catch (e) {
      return makePage(relPath, localPath, url, 'error', { error: e.message });
    }
  });

  // sitemap.xmlによる新規ページ検出
  let sitemapNote = '';
  try {
    const locs = await fetchSitemapLocs(baseUrl, authHeader);
    if (locs) {
      const localPathSet = new Set(pages.map((p) => p.relPath));
      const seen = new Set();
      for (const loc of locs) {
        const rel = htmlDiff.sitemapUrlToRelPath(loc, baseUrl);
        if (!rel || seen.has(rel) || localPathSet.has(rel)) continue;
        seen.add(rel);
        const url = htmlDiff.joinUrl(baseUrl, rel);
        try {
          const remoteText = await fetchRemoteText(url, authHeader);
          remoteTextMap.set(rel, remoteText);
          const localPath = path.join(localRoot, ...rel.split('/'));
          pages.push(makePage(rel, localPath, url, 'server-only'));
        } catch (e) {
          // 新規ページの取得に失敗した場合は一覧に含めない(サーバー側のエラーとして黙って除外する)
        }
      }
    } else {
      sitemapNote = 'sitemap.xml が見つからないため、新規ページの検出はスキップしました。';
    }
  } catch (e) {
    sitemapNote = 'sitemap.xml の確認中にエラーが発生したため、新規ページの検出はスキップしました。';
  }

  pages.sort((a, b) => a.relPath.localeCompare(b.relPath));
  lastPages = pages;
  return { pages, sitemapNote };
}

function ensureBackup(file) {
  const bak = `${file}.bak`;
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
  }
}

function replacePage(updatedPage) {
  const idx = lastPages.findIndex((p) => p.relPath === updatedPage.relPath);
  if (idx !== -1) lastPages[idx] = updatedPage;
  else lastPages.push(updatedPage);
  return updatedPage;
}

// 該当ページのremoteText(スキャン時に保持)でローカルファイルを上書きする。
// 上書き前に初回のみ .bak を作成する(server-onlyページの場合は新規作成のため.bakは無し)。
// 書き込み後、再fetch無しでlocalText=remoteTextとして再比較する(常にidentical)。
function syncPage(relPath) {
  const page = lastPages.find((p) => p.relPath === relPath);
  if (!page) return { ok: false, error: 'ページが見つかりません(再スキャンが必要かもしれません)' };

  const remoteText = remoteTextMap.get(relPath);
  if (remoteText === undefined) {
    return { ok: false, error: 'サーバー側の内容が保持されていません(再スキャンしてください)' };
  }

  try {
    if (page.status === 'server-only') {
      fs.mkdirSync(path.dirname(page.localPath), { recursive: true });
      fs.writeFileSync(page.localPath, remoteText, 'utf8');
    } else {
      ensureBackup(page.localPath);
      fs.writeFileSync(page.localPath, remoteText, 'utf8');
    }
  } catch (e) {
    return { ok: false, error: `書き込みに失敗しました: ${e.message}` };
  }

  const updatedPage = replacePage(buildComparedPage(page.relPath, page.localPath, page.url, remoteText, remoteText));
  return { ok: true, updatedPage };
}

// 差分状態(includeNewがtrueならserver-onlyも含む)の全ページを順次同期する。
async function syncAll(includeNew) {
  const targets = lastPages.filter((p) => p.status === 'diff' || (includeNew && p.status === 'server-only'));
  const results = [];
  for (const page of targets) {
    const r = syncPage(page.relPath);
    results.push({ relPath: page.relPath, ok: r.ok, error: r.error });
  }
  return { ok: true, results, pages: lastPages };
}

// ローカルファイル.bakがあれば復元し、スキャン時に保持したremoteTextと再比較する。
function restoreBackup(relPath) {
  const page = lastPages.find((p) => p.relPath === relPath);
  if (!page) return { ok: false, error: 'ページが見つかりません' };

  const bak = `${page.localPath}.bak`;
  if (!fs.existsSync(bak)) {
    return { ok: false, error: 'バックアップが見つかりません' };
  }
  fs.copyFileSync(bak, page.localPath);

  const remoteText = remoteTextMap.get(relPath);
  let updatedPage;
  try {
    const localText = fs.readFileSync(page.localPath, 'utf8');
    if (remoteText === undefined) {
      updatedPage = makePage(page.relPath, page.localPath, page.url, 'error', {
        error: 'サーバー側の内容が保持されていません(再スキャンしてください)',
      });
    } else {
      updatedPage = buildComparedPage(page.relPath, page.localPath, page.url, localText, remoteText);
    }
  } catch (e) {
    updatedPage = makePage(page.relPath, page.localPath, page.url, 'error', { error: e.message });
  }

  replacePage(updatedPage);
  return { ok: true, updatedPage };
}

module.exports = {
  resetState,
  getPages,
  walkHtmlFiles,
  runPool,
  fetchRemoteText,
  fetchSitemapLocs,
  scanSite,
  syncPage,
  syncAll,
  restoreBackup,
};
