'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { fitBounds, createWindowStateKeeper } = require('../lib/windowState');

const MAIN = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 };
const LEFT = { x: -1280, y: 100, width: 1280, height: 900 };
const MIN = { minWidth: 520, minHeight: 360 };

const fit = (saved, ...areas) => fitBounds(saved, areas, MIN);

test('画面内ならそのまま', () => {
  const saved = { x: 200, y: 100, width: 1200, height: 800 };
  assert.deepEqual(fit(saved, MAIN), saved);
});

test('モニタ情報が空ならそのまま', () => {
  const saved = { x: 5000, y: 5000, width: 800, height: 600 };
  assert.deepEqual(fitBounds(saved, [], MIN), saved);
});

test('モニタが取り外されて画面外になったら、残ったモニタの中へ戻す', () => {
  const r = fit({ x: 2500, y: 200, width: 1200, height: 800 }, MAIN);
  assert.ok(r.x >= MAIN.x && r.x + r.width <= MAIN.x + MAIN.width);
  assert.ok(r.y >= MAIN.y && r.y + r.height <= MAIN.y + MAIN.height);
  assert.equal(r.width, 1200);
});

test('画面より大きければ縮める', () => {
  assert.deepEqual(fit({ x: 0, y: 0, width: 4000, height: 3000 }, MAIN), MAIN);
});

test('小さすぎれば最小サイズまで広げる', () => {
  const r = fit({ x: 100, y: 100, width: 100, height: 100 }, MAIN);
  assert.equal(r.width, 520);
  assert.equal(r.height, 360);
});

test('2枚のモニタにまたがる配置は維持する', () => {
  const saved = { x: 1400, y: 200, width: 1600, height: 900 };
  assert.deepEqual(fit(saved, MAIN, RIGHT), saved);
});

test('大きくはみ出していても、タイトルバーがつかめれば維持する', () => {
  const saved = { x: -1000, y: 100, width: 1200, height: 800 };
  assert.deepEqual(fit(saved, MAIN), saved);
});

test('完全に画面外(左)なら引き戻す', () => {
  const r = fit({ x: -3000, y: 100, width: 1200, height: 800 }, MAIN);
  assert.ok(r.x >= MAIN.x);
  assert.ok(r.x + r.width <= MAIN.width);
});

test('下端より下なら引き戻す', () => {
  const r = fit({ x: 300, y: 2000, width: 1200, height: 800 }, MAIN);
  assert.ok(r.y + r.height <= MAIN.y + MAIN.height);
});

test('座標が負のモニタも扱える(プライマリの左にあるモニタ)', () => {
  const saved = { x: -1100, y: 200, width: 900, height: 600 };
  assert.deepEqual(fit(saved, LEFT, MAIN), saved);
});

test('保存時のモニタが無くなったら、近い方のモニタへ', () => {
  const r = fit({ x: -1200, y: 200, width: 900, height: 600 }, MAIN, RIGHT);
  assert.ok(r.x >= MAIN.x && r.x + r.width <= MAIN.x + MAIN.width);
});

// ------------------------------------------------------------------ createWindowStateKeeper
function fakeScreen(areas) {
  return {
    getAllDisplays: () => areas.map((workArea) => ({ workArea })),
    getPrimaryDisplay: () => ({ workArea: areas[0] }),
  };
}

function fakeWindow(initial) {
  const win = new EventEmitter();
  let bounds = { ...initial };
  let maximized = false;
  win.getNormalBounds = () => ({ ...bounds });
  win.isMaximized = () => maximized;
  win.isDestroyed = () => false;
  win.isFullScreen = () => false;
  win.setBounds = (b) => { bounds = { ...b }; };
  win.setMaximized = (m) => { maximized = m; };
  return win;
}

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'window-state.json');
}

const keeperOptions = (file, areas = [MAIN]) => ({
  file, defaultWidth: 1200, defaultHeight: 800, minWidth: 520, minHeight: 360, screen: fakeScreen(areas),
});

test('保存が無ければ、プライマリの中央に既定の大きさで置く', (t) => {
  const s = createWindowStateKeeper(keeperOptions(tempFile(t))).load();
  assert.equal(s.width, 1200);
  assert.equal(s.height, 800);
  assert.equal(s.x, Math.round((1920 - 1200) / 2));
  assert.equal(s.isMaximized, false);
});

test('既定の大きさが画面より大きければ、画面に収める', (t) => {
  const small = { x: 0, y: 0, width: 1000, height: 700 };
  const s = createWindowStateKeeper(keeperOptions(tempFile(t), [small])).load();
  assert.equal(s.width, 1000);
  assert.equal(s.height, 700);
});

test('壊れた保存ファイルは無視して既定を使う', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, '{壊れ');
  const s = createWindowStateKeeper(keeperOptions(file)).load();
  assert.equal(s.width, 1200);
});

test('閉じるときに保存され、次回の起動で復元される(最大化も)', (t) => {
  const file = tempFile(t);
  const keeper = createWindowStateKeeper(keeperOptions(file));

  const win = fakeWindow({ x: 300, y: 200, width: 1000, height: 640 });
  keeper.manage(win);
  win.setMaximized(true);
  win.emit('close');

  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual(saved, { x: 300, y: 200, width: 1000, height: 640, isMaximized: true });

  const restored = createWindowStateKeeper(keeperOptions(file)).load();
  assert.deepEqual(restored, { x: 300, y: 200, width: 1000, height: 640, isMaximized: true });
});

test('移動やサイズ変更の少し後に、自動で保存される(強制終了に備える)', async (t) => {
  const file = tempFile(t);
  const keeper = createWindowStateKeeper(keeperOptions(file));
  const win = fakeWindow({ x: 10, y: 20, width: 900, height: 600 });
  keeper.manage(win);

  win.setBounds({ x: 50, y: 60, width: 950, height: 650 });
  win.emit('move');
  win.emit('resize');
  assert.equal(fs.existsSync(file), false, 'すぐには書かない(デバウンス)');

  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')),
    { x: 50, y: 60, width: 950, height: 650, isMaximized: false });
});

test('モニタ構成が変わっていたら、復元時に補正される', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, JSON.stringify({ x: 3000, y: 300, width: 1000, height: 700, isMaximized: false }));
  const s = createWindowStateKeeper(keeperOptions(file, [MAIN])).load();
  assert.ok(s.x + s.width <= MAIN.width, '画面内に戻っている');
});
