'use strict';

/* =========================================================================
 * htmlDiff.js
 * ローカルHTMLと公開サーバー上のHTMLを比較するための純粋関数群。
 * DOM/Electronに依存しないため、Node環境でそのまま単体テスト可能。
 * 既存アプリ「YMB EJS差分同期ツール」の web/script.js からロジックを移植したもの。
 * ========================================================================= */

// 汎用LCSベース差分(行配列にも文字配列にも使える)。
// 計算量ガード: 要素数の積が4,000,000を超える場合はnullを返し、呼び出し側でフォールバック表示する。
function diffArrays(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return null;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'same', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'removed', line: a[i] }); i++; }
    else { ops.push({ type: 'added', line: b[j] }); j++; }
  }
  while (i < n) { ops.push({ type: 'removed', line: a[i] }); i++; }
  while (j < m) { ops.push({ type: 'added', line: b[j] }); j++; }
  return mergeAdjacent(ops);
}

function mergeAdjacent(ops) {
  const merged = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) last.line += op.line;
    else merged.push({ ...op });
  }
  return merged;
}

// 行単位の差分をhunk(same/changed)にまとめる。
function groupOps(ops) {
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'same') {
      hunks.push({ type: 'same', lines: [ops[i].line] });
      i++;
    } else {
      const removed = [];
      const added = [];
      while (i < ops.length && ops[i].type === 'removed') { removed.push(ops[i].line); i++; }
      while (i < ops.length && ops[i].type === 'added') { added.push(ops[i].line); i++; }
      hunks.push({ type: 'changed', removed, added });
    }
  }
  return hunks;
}

function trimCommon(oldVal, newVal) {
  const maxLen = Math.min(oldVal.length, newVal.length);
  let prefix = 0;
  while (prefix < maxLen && oldVal[prefix] === newVal[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = maxLen - prefix;
  while (suffix < maxSuffix && oldVal[oldVal.length - 1 - suffix] === newVal[newVal.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

// changedフックの中身をさらに文字単位で差分表示するための関数。nullなら大きすぎるのでプレーン表示にフォールバック。
function charDiff(oldStr, newStr) {
  const { prefix, suffix } = trimCommon(oldStr, newStr);
  const oldMid = oldStr.slice(prefix, oldStr.length - suffix);
  const newMid = newStr.slice(prefix, newStr.length - suffix);
  const midOps = diffArrays(Array.from(oldMid), Array.from(newMid));
  if (midOps === null) return null;
  const segments = [];
  if (prefix) segments.push({ value: oldStr.slice(0, prefix) });
  for (const op of midOps) {
    segments.push({
      value: op.line,
      added: op.type === 'added' ? true : undefined,
      removed: op.type === 'removed' ? true : undefined,
    });
  }
  if (suffix) segments.push({ value: oldStr.slice(oldStr.length - suffix) });
  return segments;
}

// テキスト同士の比較エントリポイント。行末はCRLF/CR/LFの差異を無視するため正規化してから比較する
// (プラットフォーム間の改行コード差だけを「差分」として誤検知しないため)。
function normalizeText(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function comparePages(oldText, newText) {
  const a = normalizeText(oldText);
  const b = normalizeText(newText);
  if (a === b) return { identical: true };
  const lineOps = diffArrays(a.split('\n'), b.split('\n'));
  if (lineOps === null) {
    return { identical: false, tooLargeForLineDiff: true };
  }
  const hunks = groupOps(lineOps).filter((h) => h.type === 'changed');
  const rendered = hunks.map((h) => {
    const oldJoined = h.removed.join('\n');
    const newJoined = h.added.join('\n');
    const cd = charDiff(oldJoined, newJoined);
    return { removedText: oldJoined, addedText: newJoined, charDiff: cd };
  });
  return { identical: false, hunks: rendered };
}

// baseUrlとrelPathを二重スラッシュにならないように結合する。
function joinUrl(base, relPath) {
  const b = String(base).replace(/\/+$/, '');
  const r = String(relPath).replace(/^\/+/, '');
  return b + '/' + r;
}

// sitemap.xmlの<loc>URLを、baseUrl配下のローカル相対パスに変換する。
// baseUrl外のURLはnullを返す(呼び出し側で除外する)。
// 末尾が'/'の場合は'index.html'を補い、'.html'で終わらないパスには'/index.html'を補う。
function sitemapUrlToRelPath(locUrl, baseUrl) {
  let u;
  let b;
  try {
    u = new URL(locUrl);
    b = new URL(baseUrl);
  } catch (e) {
    return null;
  }
  if (u.origin !== b.origin) return null;

  let basePath = b.pathname;
  if (!basePath.endsWith('/')) basePath += '/';

  if (!u.pathname.startsWith(basePath)) return null;

  let rel = u.pathname.slice(basePath.length);
  if (rel === '' || rel.endsWith('/')) {
    rel += 'index.html';
  } else if (!rel.toLowerCase().endsWith('.html')) {
    rel += '/index.html';
  }
  return rel;
}

// HTML文字列から<a href="...">のhref値を全部抜き出す(href='...'/href="..."両対応、大文字小文字無視)。
function extractHrefs(html) {
  const hrefs = [];
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1] !== undefined ? m[1] : m[2];
    if (href) hrefs.push(href);
  }
  return hrefs;
}

// リンククロール用: hrefをpageUrl基準で解決し、baseUrl配下のローカル相対パスに変換する。
// mailto:/tel:/javascript:、外部オリジン、baseUrl配下でないパスはnullを返す。
// フラグメント(#)・クエリ(?)はURL解決の時点で自動的に無視される(pathnameのみ使うため)。
// 末尾'/' -> 'index.html'補完、'.html'終わり -> そのまま、拡張子無し -> '/index.html'補完、
// それ以外の拡張子(.jpg/.css/.js/.pdf等) -> null(対象外)。
function resolveCrawlRelPath(href, pageUrl, baseUrl) {
  const trimmed = String(href || '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('mailto:') || lower.startsWith('tel:') || lower.startsWith('javascript:')) return null;

  let resolved;
  let base;
  try {
    resolved = new URL(trimmed, pageUrl);
    base = new URL(baseUrl);
  } catch (e) {
    return null;
  }
  if (resolved.origin !== base.origin) return null;

  let basePath = base.pathname;
  if (!basePath.endsWith('/')) basePath += '/';
  if (!resolved.pathname.startsWith(basePath)) return null;

  let rel = resolved.pathname.slice(basePath.length);
  if (rel === '' || rel.endsWith('/')) {
    rel += 'index.html';
  } else if (rel.toLowerCase().endsWith('.html')) {
    // そのまま
  } else if (/\.[a-z0-9]+$/i.test(rel)) {
    return null; // .html以外の拡張子は対象外
  } else {
    rel += '/index.html';
  }
  return rel;
}

// HTMLへの差し込み用エスケープ(XSS対策)。
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

module.exports = {
  diffArrays,
  mergeAdjacent,
  groupOps,
  trimCommon,
  charDiff,
  normalizeText,
  comparePages,
  joinUrl,
  sitemapUrlToRelPath,
  extractHrefs,
  resolveCrawlRelPath,
  escapeHtml,
};
