import test from 'node:test';
import assert from 'node:assert/strict';
import { createSync, isSecureTransport, sanitizeScope, buildAuthHeader } from '../renderer/core/htmlSync.js';

// 偽の入出力。ローカルのファイルとサーバーの内容を、メモリの上に持つ。
function fakeIo({ local = {}, remote = {} } = {}) {
  const files = new Map(Object.entries(local));
  const backups = new Map();
  const calls = { fetch: [], write: [] };
  return {
    files,
    backups,
    calls,
    async setRoot(r) { return r; },
    async listHtml(start) {
      return [...files.keys()].filter((k) => !start || k.startsWith(start + '/')).sort();
    },
    async localPath(rel) { return '/root/' + rel; },
    async readLocal(rel) {
      if (!files.has(rel)) throw new Error('ENOENT');
      return files.get(rel);
    },
    async writeLocal(rel, text, backup) {
      calls.write.push({ rel, backup });
      if (backup && files.has(rel) && !backups.has(rel)) backups.set(rel, files.get(rel));
      files.set(rel, text);
    },
    async restoreLocal(rel) {
      if (!backups.has(rel)) throw new Error('バックアップが見つかりません');
      files.set(rel, backups.get(rel));
      return backups.get(rel);
    },
    async fetchText(url, auth) {
      calls.fetch.push({ url, auth });
      if (url in remote) return remote[url];
      throw { message: 'HTTPステータス 404 が返されました', status: 404 };
    },
  };
}

const BASE = 'https://x.test/site';
const args = (extra = {}) => ({ localRoot: '/root', baseUrl: BASE, scope: '', crawl: false, ...extra });

test('scan: 一致・差分・取得失敗を分けて返す', async () => {
  const io = fakeIo({
    local: { 'a.html': '<p>A</p>', 'b.html': '<p>B</p>', 'c.html': '<p>C</p>' },
    remote: { [`${BASE}/a.html`]: '<p>A</p>', [`${BASE}/b.html`]: '<p>B2</p>' },
  });
  const { pages } = await createSync(io).scanSite(args());
  const by = Object.fromEntries(pages.map((p) => [p.relPath, p]));
  assert.equal(by['a.html'].status, 'identical');
  assert.equal(by['b.html'].status, 'diff');
  assert.equal(by['c.html'].status, 'error');
  assert.match(by['c.html'].error, /404/);
  assert.equal(by['a.html'].localPath, '/root/a.html');
});

test('scan: sitemap にだけあるページは server-only(同じオリジンだけ)', async () => {
  const io = fakeIo({
    local: { 'a.html': '<p>A</p>' },
    remote: {
      [`${BASE}/a.html`]: '<p>A</p>',
      'https://x.test/sitemap.xml': `<urlset><url><loc>${BASE}/new.html</loc></url><url><loc>https://evil.test/site/x.html</loc></url></urlset>`,
      [`${BASE}/new.html`]: '<p>NEW</p>',
    },
  });
  const { pages, sitemapNote } = await createSync(io).scanSite(args());
  assert.deepEqual(pages.map((p) => [p.relPath, p.status]), [['a.html', 'identical'], ['new.html', 'server-only']]);
  assert.match(sitemapNote, /sitemapから1件/);
  assert.ok(!io.calls.fetch.some((c) => c.url.includes('evil.test')));
});

test('scan: sitemap が無ければ、案内の文を付ける', async () => {
  const io = fakeIo({ local: { 'a.html': '<p>A</p>' }, remote: { [`${BASE}/a.html`]: '<p>A</p>' } });
  const { sitemapNote } = await createSync(io).scanSite(args());
  assert.match(sitemapNote, /sitemap\.xml が見つからない/);
});

test('scan: クロールで、リンク先の新規ページを見つける', async () => {
  const io = fakeIo({
    local: { 'a.html': '<a href="n1.html">n</a>' },
    remote: {
      [`${BASE}/a.html`]: '<a href="n1.html">n</a>',
      [`${BASE}/n1.html`]: '<a href="n2.html">m</a>',
      [`${BASE}/n2.html`]: '<p>end</p>',
    },
  });
  const { pages } = await createSync(io).scanSite(args({ crawl: true }));
  assert.deepEqual(pages.map((p) => p.relPath), ['a.html', 'n1.html', 'n2.html']);
  assert.equal(pages[1].status, 'server-only');
});

test('scan: Basic 認証は https かローカルホストだけ。資格情報の送信先は、指定のサーバーだけ', async () => {
  const io = fakeIo({ local: { 'a.html': 'x' }, remote: {} });
  const sync = createSync(io);
  await assert.rejects(() => sync.scanSite(args({ baseUrl: 'http://x.test/site', basicUser: 'u', basicPass: 'p' })), /HTTPS/);
  await assert.rejects(() => sync.scanSite(args({ baseUrl: 'ftp://x.test/' })), /http:\/\//);
  assert.equal(isSecureTransport('http://localhost:8080/'), true);
  assert.equal(isSecureTransport('http://127.0.0.1/'), true);
  assert.equal(isSecureTransport('http://example.com/'), false);
  assert.equal(buildAuthHeader('ユーザー', 'pw'), 'Basic ' + Buffer.from('ユーザー:pw').toString('base64'));
  assert.equal(buildAuthHeader('', 'pw'), null);
});

test('sanitizeScope: .. は拒否、先頭と末尾のスラッシュは外す', () => {
  assert.equal(sanitizeScope('/a/b/'), 'a/b');
  assert.equal(sanitizeScope('a\\b'), 'a/b');
  assert.equal(sanitizeScope('./a'), 'a');
  assert.equal(sanitizeScope(''), '');
  assert.throws(() => sanitizeScope('a/../b'), /\.\./);
});

test('sync: 上書き前に初回だけ .bak、server-only は .bak なし、書いた後は identical', async () => {
  const io = fakeIo({
    local: { 'b.html': '古い' },
    remote: { [`${BASE}/b.html`]: '新しい', 'https://x.test/sitemap.xml': `<loc>${BASE}/n.html</loc>`, [`${BASE}/n.html`]: '新規' },
  });
  const sync = createSync(io);
  await sync.scanSite(args());
  const r1 = await sync.syncPage('b.html');
  assert.equal(r1.ok, true);
  assert.equal(r1.updatedPage.status, 'identical');
  assert.equal(io.files.get('b.html'), '新しい');
  assert.equal(io.backups.get('b.html'), '古い');
  const r2 = await sync.syncPage('n.html');
  assert.equal(r2.ok, true);
  assert.deepEqual(io.calls.write.map((w) => [w.rel, w.backup]), [['b.html', true], ['n.html', false]]);
});

test('syncAll: 差分だけ(includeNew なら新規も)', async () => {
  const io = fakeIo({
    local: { 'a.html': 'A', 'b.html': 'B' },
    remote: { [`${BASE}/a.html`]: 'A', [`${BASE}/b.html`]: 'B2', 'https://x.test/sitemap.xml': `<loc>${BASE}/n.html</loc>`, [`${BASE}/n.html`]: 'N' },
  });
  const sync = createSync(io);
  await sync.scanSite(args());
  const r = await sync.syncAll(false);
  assert.deepEqual(r.results.map((x) => x.relPath), ['b.html']);
  const r2 = await sync.syncAll(true);
  assert.deepEqual(r2.results.map((x) => x.relPath), ['n.html']);
});

test('restore: .bak から戻して、サーバーと再比較する。.bak が無ければ失敗', async () => {
  const io = fakeIo({ local: { 'b.html': '古い' }, remote: { [`${BASE}/b.html`]: '新しい' } });
  const sync = createSync(io);
  await sync.scanSite(args());
  assert.equal((await sync.restoreBackup('b.html')).ok, false);
  await sync.syncPage('b.html');
  const r = await sync.restoreBackup('b.html');
  assert.equal(r.ok, true);
  assert.equal(r.updatedPage.status, 'diff');
  assert.equal(io.files.get('b.html'), '古い');
  assert.equal((await sync.restoreBackup('nothing.html')).ok, false);
});

test('syncPage: スキャン前は失敗(ページが見つかりません)', async () => {
  const r = await createSync(fakeIo()).syncPage('a.html');
  assert.equal(r.ok, false);
});
