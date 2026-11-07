/* =========================================================================
 * htmlSync.js
 * コア処理(ローカル走査・リモート取得・比較・同期・復元)の手順。
 * ファイルや通信といった入出力は、`io` として外から渡す(Tauri では Rust のコマンド、テストでは偽物)。
 * 手順そのものは、ブラウザの画面側(ES モジュール)でも、Node でも、そのまま動く。
 *
 * io の形:
 *   setRoot(root) -> 正規化したルートのパス
 *   listHtml(startRel) -> ルートからの相対パス(/ 区切り、startRel を含む)の配列
 *   localPath(rel) -> 表示用の絶対パス
 *   readLocal(rel) -> テキスト(失敗したら例外)
 *   writeLocal(rel, text, backup) -> 書き込み(backup が真なら初回だけ .bak を残す)
 *   restoreLocal(rel) -> .bak から復元して、復元後のテキストを返す(.bak が無ければ例外)
 *   fetchText(url, auth, timeoutMs, maxBytes) -> テキスト(失敗したら { message, status } を投げる)
 * ========================================================================= */

import * as htmlDiff from './htmlDiff.js';

const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 4;
const CRAWL_DEFAULT_LIMIT = 200; // リンククロールで新たにfetchするページ数の上限
const SITEMAPINDEX_MAX_CHILDREN = 10; // sitemapindexから辿る子sitemapの上限
const SITEMAPINDEX_MAX_DEPTH = 3; // 子sitemapがさらにsitemapindexだった場合の再帰上限
const MAX_REMOTE_BYTES = 8 * 1024 * 1024; // リモートから取得する1レスポンスのサイズ上限

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

// 2つのURLが同一オリジン(scheme+host+port)かどうかを判定する。不正なURLはfalse。
// SSRF対策と、Basic認証情報を外部オリジンへ送らないための判定に使う。
function isSameOrigin(urlStr, referenceUrl) {
  try {
    return new URL(urlStr).origin === new URL(referenceUrl).origin;
  } catch (e) {
    return false;
  }
}

function errorMessage(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  return String(e);
}

// Basic認証で資格情報を送る場合、HTTPS(またはローカルホスト)に限定する。平文HTTPへの資格情報送信を防ぐ。
function isSecureTransport(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch (e) {
    return false;
  }
  if (u.protocol === 'https:') return true;
  const host = u.hostname.toLowerCase();
  return u.protocol === 'http:' &&
    (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1');
}

// UTF-8 の文字列を Base64 にする(ブラウザの btoa は Latin-1 だけなので、先にバイト列にする)。
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function buildAuthHeader(basicUser, basicPass) {
  return basicUser && basicPass ? 'Basic ' + toBase64(`${basicUser}:${basicPass}`) : null;
}

// scopeを安全な相対パスに正規化する。親ディレクトリ参照('..')は拒否する(ルート外へ出られない)。
function sanitizeScope(scope) {
  if (!scope) return '';
  const cleaned = scope.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  if (!cleaned) return '';
  const rawParts = cleaned.split(/[\\/]+/).filter((s) => s);
  if (rawParts.some((s) => s === '..')) {
    throw new Error('対象サブディレクトリに親ディレクトリ参照(..)は指定できません');
  }
  const parts = rawParts.filter((s) => s !== '.');
  return parts.join('/');
}

function makePage(relPath, localPath, url, status, extra = {}) {
  return { relPath, localPath, url, status, ...extra };
}

// localTextとremoteTextを比較し、画面表示用のページオブジェクトを組み立てる。
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

/**
 * 1 回のスキャンの状態(取得したサーバー側のテキスト、ページ一覧)を持つ「同期ツール」を作る。
 * Electron 版では、モジュールのグローバル変数に持っていたものを、ここで閉じ込めている。
 */
export function createSync(io) {
  // 直近のスキャンで取得したサーバー側のテキストを保持する(relPath -> text)。
  const remoteTextMap = new Map();
  // 直近のスキャン結果(ページ一覧)。syncPage/syncAll/restoreBackupの対象特定に使う。
  let lastPages = [];

  function resetState() {
    remoteTextMap.clear();
    lastPages = [];
  }

  function getPages() {
    return lastPages;
  }

  // サーバーのテキストを取得する。Basic認証・タイムアウト(15秒)・サイズ上限(8MB)・エラー種別は、io 側で判定する。
  async function fetchRemoteText(url, authHeader, timeoutMs = FETCH_TIMEOUT_MS) {
    try {
      return await io.fetchText(url, authHeader, timeoutMs, MAX_REMOTE_BYTES);
    } catch (e) {
      const err = new Error(errorMessage(e));
      if (e && typeof e === 'object' && e.status !== undefined && e.status !== null) err.status = e.status;
      throw err;
    }
  }

  // origin直下のrobots.txtを取得し、"Sitemap:"行(大文字小文字無視)のURLを一覧で返す。失敗したら空配列。
  async function fetchRobotsSitemaps(origin, authHeader) {
    try {
      const text = await fetchRemoteText(origin + '/robots.txt', authHeader, FETCH_TIMEOUT_MS);
      const urls = [];
      const re = /^\s*sitemap\s*:\s*(\S+)\s*$/gim;
      let m;
      while ((m = re.exec(text)) !== null) {
        const url = m[1].trim();
        if (url) urls.push(url);
      }
      return urls;
    } catch (e) {
      return [];
    }
  }

  // sitemap XMLを1件取得して<loc>一覧を返す。<sitemapindex>形式の場合は子sitemapを順に辿って
  // (最大SITEMAPINDEX_MAX_CHILDREN個、再帰深さSITEMAPINDEX_MAX_DEPTHまで)集約する。
  // SSRF対策として、<loc>・子sitemapのURLは、同一オリジンのものだけ採用する。
  async function fetchSitemapLocsFromXml(url, authHeader, depth = 0, rootOrigin = null) {
    const text = await fetchRemoteText(url, authHeader, FETCH_TIMEOUT_MS);
    const allowed = rootOrigin ?? url;
    const locs = [];
    const re = /<loc>(.*?)<\/loc>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const loc = m[1].trim();
      if (loc && isSameOrigin(loc, allowed)) locs.push(loc);
    }
    if (/<sitemapindex[\s>]/i.test(text) && depth < SITEMAPINDEX_MAX_DEPTH) {
      const childUrls = locs.slice(0, SITEMAPINDEX_MAX_CHILDREN);
      const aggregated = [];
      for (const childUrl of childUrls) {
        try {
          const childLocs = await fetchSitemapLocsFromXml(childUrl, authHeader, depth + 1, allowed);
          aggregated.push(...childLocs);
        } catch (e) {
          // 子sitemapの取得失敗は無視して他の子を続行する
        }
      }
      return aggregated;
    }
    return locs;
  }

  // sitemap候補(robots.txtのSitemap:行 → origin直下 → baseUrl直下)を順に試す。すべて失敗したらnull。
  async function fetchSitemapLocs(baseUrl, authHeader) {
    let origin;
    try {
      origin = new URL(baseUrl).origin;
    } catch (e) {
      return null;
    }
    const robotsSitemaps = await fetchRobotsSitemaps(origin, authHeader);
    const candidates = Array.from(new Set([
      ...robotsSitemaps,
      origin + '/sitemap.xml',
      htmlDiff.joinUrl(baseUrl, 'sitemap.xml'),
    ]));
    for (const url of candidates) {
      try {
        return await fetchSitemapLocsFromXml(url, authHeader, 0, origin);
      } catch (e) {
        // 次の候補を試す
      }
    }
    return null;
  }

  // リンクを辿って新規ページ(ローカルに無いページ)を検出する(BFS)。
  async function crawlForNewPages({ baseUrl, authHeader, localPathSet, foundRelPathSet, seedTexts, crawlLimit = CRAWL_DEFAULT_LIMIT }) {
    const queue = [];
    const queued = new Set(); // キュー投入済みrelPath(重複fetch防止)
    const newPages = [];
    let fetchCount = 0;
    let limitReached = false;

    function enqueueFromHtml(html, pageUrl) {
      for (const href of htmlDiff.extractHrefs(html)) {
        const rel = htmlDiff.resolveCrawlRelPath(href, pageUrl, baseUrl);
        if (!rel) continue;
        if (localPathSet.has(rel) || foundRelPathSet.has(rel) || queued.has(rel)) continue;
        queued.add(rel);
        queue.push(rel);
      }
    }

    for (const seed of seedTexts) {
      enqueueFromHtml(seed.text, htmlDiff.joinUrl(baseUrl, seed.relPath));
    }
    try {
      const baseHtml = await fetchRemoteText(baseUrl, authHeader);
      enqueueFromHtml(baseHtml, baseUrl);
    } catch (e) {
      // baseUrl自体が取得できなくても、既知ページのリンクだけで探索を続ける
    }

    while (queue.length > 0) {
      if (fetchCount >= crawlLimit) {
        limitReached = true;
        break;
      }
      const remaining = crawlLimit - fetchCount;
      const batch = queue.splice(0, Math.min(CONCURRENCY, remaining));
      fetchCount += batch.length;

      const results = await runPool(batch, CONCURRENCY, async (rel) => {
        const url = htmlDiff.joinUrl(baseUrl, rel);
        try {
          const text = await fetchRemoteText(url, authHeader);
          return { rel, url, text };
        } catch (e) {
          return null; // 404等の失敗はノイズにしないため黙って除外
        }
      });

      for (const r of results) {
        if (!r) continue;
        foundRelPathSet.add(r.rel);
        newPages.push(r);
        enqueueFromHtml(r.text, r.url);
      }
    }
    if (queue.length > 0 && fetchCount >= crawlLimit) limitReached = true;

    return { newPages, limitReached };
  }

  // localRoot(+scope配下)を再帰走査して*.htmlを列挙し、公開サーバーの対応ページと比較する。
  // さらにsitemap.xml(+robots.txt由来・sitemapindex対応)や、crawl:trueならリンククロールから
  // ローカルに無いページ(server-only)を検出して一覧に加える。
  async function scanSite({ localRoot, baseUrl, basicUser, basicPass, scope, crawl, crawlLimit }) {
    resetState();

    // 公開サーバーURLは http/https のみ許可する。
    try {
      const parsedBase = new URL(baseUrl);
      if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') throw new Error();
    } catch (e) {
      throw new Error('公開サーバーURLは http:// または https:// で始まるURLを指定してください');
    }
    // Basic認証を使う場合はHTTPS(またはローカルホスト)を強制する。
    if ((basicUser || basicPass) && !isSecureTransport(baseUrl)) {
      throw new Error('Basic認証を使う場合はHTTPS(またはローカルホスト)のサーバーを指定してください');
    }

    const authHeader = buildAuthHeader(basicUser, basicPass);
    const normalizedScope = sanitizeScope(scope);
    await io.setRoot(localRoot);

    const relPaths = await io.listHtml(normalizedScope);

    const pages = await runPool(relPaths, CONCURRENCY, async (relPath) => {
      const localPath = await io.localPath(relPath);
      const url = htmlDiff.joinUrl(baseUrl, relPath);
      let localText;
      try {
        localText = await io.readLocal(relPath);
      } catch (e) {
        return makePage(relPath, localPath, url, 'error', { error: `ローカルファイルの読み込みに失敗しました: ${errorMessage(e)}` });
      }
      try {
        const remoteText = await fetchRemoteText(url, authHeader);
        remoteTextMap.set(relPath, remoteText);
        return buildComparedPage(relPath, localPath, url, localText, remoteText);
      } catch (e) {
        return makePage(relPath, localPath, url, 'error', { error: errorMessage(e) });
      }
    });

    const localPathSet = new Set(pages.map((p) => p.relPath));
    // sitemap・クロールの両方を通じて既に発見済みのrelPath(重複検出防止に共用する)
    const foundRelPathSet = new Set();

    // sitemap.xml(robots.txt由来の候補・sitemapindex対応)による新規ページ検出
    let sitemapNewCount = 0;
    let sitemapUnavailable = false;
    let sitemapError = false;
    try {
      const locs = await fetchSitemapLocs(baseUrl, authHeader);
      if (locs) {
        for (const loc of locs) {
          const rel = htmlDiff.sitemapUrlToRelPath(loc, baseUrl);
          if (!rel || foundRelPathSet.has(rel) || localPathSet.has(rel)) continue;
          foundRelPathSet.add(rel);
          const url = htmlDiff.joinUrl(baseUrl, rel);
          try {
            const remoteText = await fetchRemoteText(url, authHeader);
            remoteTextMap.set(rel, remoteText);
            pages.push(makePage(rel, await io.localPath(rel), url, 'server-only'));
            sitemapNewCount++;
          } catch (e) {
            // 新規ページの取得に失敗した場合は一覧に含めない(サーバー側のエラーとして黙って除外する)
          }
        }
      } else {
        sitemapUnavailable = true;
      }
    } catch (e) {
      sitemapError = true;
    }

    // リンククロールによる新規ページ検出(オプション、crawl:trueの場合のみ)
    let crawlNewCount = 0;
    let crawlLimitReached = false;
    if (crawl) {
      try {
        const seedTexts = Array.from(remoteTextMap.entries()).map(([relPath, text]) => ({ relPath, text }));
        const { newPages, limitReached } = await crawlForNewPages({
          baseUrl,
          authHeader,
          localPathSet,
          foundRelPathSet,
          seedTexts,
          crawlLimit: crawlLimit || CRAWL_DEFAULT_LIMIT,
        });
        crawlLimitReached = limitReached;
        for (const p of newPages) {
          remoteTextMap.set(p.rel, p.text);
          pages.push(makePage(p.rel, await io.localPath(p.rel), p.url, 'server-only'));
          crawlNewCount++;
        }
      } catch (e) {
        // クロール全体の予期しない失敗は、それまでに見つかった分を活かして黙って打ち切る
      }
    }

    // noteの組み立て: sitemap未検出/エラーの案内 + 検出手段別の件数内訳 + 上限到達の案内
    const noteParts = [];
    if (sitemapUnavailable) {
      noteParts.push('sitemap.xml が見つからないため、sitemapからの新規ページ検出はスキップしました。');
    } else if (sitemapError) {
      noteParts.push('sitemap.xml の確認中にエラーが発生したため、sitemapからの新規ページ検出はスキップしました。');
    }
    if (sitemapNewCount > 0 || crawlNewCount > 0) {
      const breakdown = [];
      if (sitemapNewCount > 0) breakdown.push(`sitemapから${sitemapNewCount}件`);
      if (crawlNewCount > 0) breakdown.push(`リンククロールから${crawlNewCount}件`);
      noteParts.push(`新規ページ: ${breakdown.join('、')}`);
    }
    if (crawlLimitReached) {
      noteParts.push(`リンククロールの取得上限(${crawlLimit || CRAWL_DEFAULT_LIMIT}件)に達したため、途中で打ち切りました。`);
    }
    const sitemapNote = noteParts.join(' ');

    pages.sort((a, b) => a.relPath.localeCompare(b.relPath));
    lastPages = pages;
    return { pages, sitemapNote };
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
  async function syncPage(relPath) {
    const page = lastPages.find((p) => p.relPath === relPath);
    if (!page) return { ok: false, error: 'ページが見つかりません(再スキャンが必要かもしれません)' };

    const remoteText = remoteTextMap.get(relPath);
    if (remoteText === undefined) {
      return { ok: false, error: 'サーバー側の内容が保持されていません(再スキャンしてください)' };
    }

    try {
      await io.writeLocal(relPath, remoteText, page.status !== 'server-only');
    } catch (e) {
      return { ok: false, error: `書き込みに失敗しました: ${errorMessage(e)}` };
    }

    const updatedPage = replacePage(buildComparedPage(page.relPath, page.localPath, page.url, remoteText, remoteText));
    return { ok: true, updatedPage };
  }

  // 差分状態(includeNewがtrueならserver-onlyも含む)の全ページを順次同期する。
  async function syncAll(includeNew) {
    const targets = lastPages.filter((p) => p.status === 'diff' || (includeNew && p.status === 'server-only'));
    const results = [];
    for (const page of targets) {
      const r = await syncPage(page.relPath);
      results.push({ relPath: page.relPath, ok: r.ok, error: r.error });
    }
    return { ok: true, results, pages: lastPages };
  }

  // ローカルファイル.bakがあれば復元し、スキャン時に保持したremoteTextと再比較する。
  async function restoreBackup(relPath) {
    const page = lastPages.find((p) => p.relPath === relPath);
    if (!page) return { ok: false, error: 'ページが見つかりません' };

    let localText;
    try {
      localText = await io.restoreLocal(relPath);
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }

    const remoteText = remoteTextMap.get(relPath);
    let updatedPage;
    if (remoteText === undefined) {
      updatedPage = makePage(page.relPath, page.localPath, page.url, 'error', {
        error: 'サーバー側の内容が保持されていません(再スキャンしてください)',
      });
    } else {
      updatedPage = buildComparedPage(page.relPath, page.localPath, page.url, localText, remoteText);
    }

    replacePage(updatedPage);
    return { ok: true, updatedPage };
  }

  return {
    resetState,
    getPages,
    fetchRemoteText,
    fetchRobotsSitemaps,
    fetchSitemapLocsFromXml,
    fetchSitemapLocs,
    crawlForNewPages,
    scanSite,
    syncPage,
    syncAll,
    restoreBackup,
  };
}

export { runPool, isSameOrigin, isSecureTransport, sanitizeScope, buildAuthHeader };
