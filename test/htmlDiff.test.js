import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffArrays, comparePages, joinUrl, sitemapUrlToRelPath, extractHrefs, resolveCrawlRelPath, escapeHtml, normalizeText,
} from '../renderer/core/htmlDiff.js';

test('comparePages: 同じ内容は identical(改行コードの違いは無視)', () => {
  assert.deepEqual(comparePages('a\r\nb\r\n', 'a\nb\n'), { identical: true });
});

test('comparePages: 変わった行をまとめて、文字単位の差分も付ける', () => {
  const r = comparePages('<p>一</p>\n<p>二</p>\n<p>三</p>', '<p>一</p>\n<p>2</p>\n<p>三</p>');
  assert.equal(r.identical, false);
  assert.equal(r.hunks.length, 1);
  assert.equal(r.hunks[0].removedText, '<p>二</p>');
  assert.equal(r.hunks[0].addedText, '<p>2</p>');
  assert.ok(Array.isArray(r.hunks[0].charDiff));
});

test('comparePages: 大きすぎると行の差分を諦める(null 相当の印)', () => {
  const a = Array.from({ length: 2100 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 2100 }, (_, i) => `b${i}`).join('\n');
  assert.equal(comparePages(a, b).tooLargeForLineDiff, true);
});

test('diffArrays: 追加と削除', () => {
  const ops = diffArrays(['a', 'b', 'c'], ['a', 'c', 'd']);
  assert.deepEqual(ops.map((o) => o.type), ['same', 'removed', 'same', 'added']);
});

test('normalizeText: CRLF と CR を LF にそろえる', () => {
  assert.equal(normalizeText('a\r\nb\rc\n'), 'a\nb\nc\n');
});

test('joinUrl: 二重スラッシュにしない', () => {
  assert.equal(joinUrl('https://x.test/site/', '/a/b.html'), 'https://x.test/site/a/b.html');
  assert.equal(joinUrl('https://x.test/site', 'a.html'), 'https://x.test/site/a.html');
});

test('sitemapUrlToRelPath: baseUrl 配下だけを、相対パスにする', () => {
  const base = 'https://x.test/site';
  assert.equal(sitemapUrlToRelPath('https://x.test/site/', base), 'index.html');
  assert.equal(sitemapUrlToRelPath('https://x.test/site/a/', base), 'a/index.html');
  assert.equal(sitemapUrlToRelPath('https://x.test/site/a/b.html', base), 'a/b.html');
  assert.equal(sitemapUrlToRelPath('https://x.test/site/a', base), 'a/index.html');
  assert.equal(sitemapUrlToRelPath('https://x.test/other/a.html', base), null);
  assert.equal(sitemapUrlToRelPath('https://evil.test/site/a.html', base), null);
  assert.equal(sitemapUrlToRelPath('not a url', base), null);
});

test('extractHrefs: 二重・単一引用符の両方、大文字小文字無視', () => {
  const html = '<a href="/a.html">x</a><A HREF=\'b.html\'>y</A><a href="">z</a>';
  assert.deepEqual(extractHrefs(html), ['/a.html', 'b.html']);
});

test('resolveCrawlRelPath: 対象外のものは null', () => {
  const base = 'https://x.test/site';
  const page = 'https://x.test/site/a/index.html';
  assert.equal(resolveCrawlRelPath('b.html', page, base), 'a/b.html');
  assert.equal(resolveCrawlRelPath('../c/', page, base), 'c/index.html');
  assert.equal(resolveCrawlRelPath('mailto:a@b.c', page, base), null);
  assert.equal(resolveCrawlRelPath('javascript:void(0)', page, base), null);
  assert.equal(resolveCrawlRelPath('https://other.test/x.html', page, base), null);
  assert.equal(resolveCrawlRelPath('/outside/x.html', page, base), null);
  assert.equal(resolveCrawlRelPath('img/a.jpg', page, base), null);
  assert.equal(resolveCrawlRelPath('b.html#top?x=1', page, base), 'a/b.html');
});

test('escapeHtml', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});
