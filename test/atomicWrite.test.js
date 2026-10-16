'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { atomicWriteFileSync, atomicWriteFile } = require('../lib/atomicWrite');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('atomicWriteFileSync: 書き込んで置き換える', (t) => {
  const file = path.join(tempDir(t), 'a.txt');
  fs.writeFileSync(file, '古い');
  atomicWriteFileSync(file, '新しい');
  assert.equal(fs.readFileSync(file, 'utf-8'), '新しい');
});

test('atomicWriteFileSync: 失敗しても、元のファイルは壊れず、一時ファイルも残らない', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, '元の内容');
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('disk error'), { code: 'EIO' });
  });
  assert.throws(() => atomicWriteFileSync(file, '新しい内容'), /disk error/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf-8'), '元の内容');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('atomicWriteFileSync: rename が一時的に EPERM で失敗しても、やり直して成功する', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, '古い');

  const real = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return real(from, to);
  });
  atomicWriteFileSync(file, '新しい');
  t.mock.restoreAll();

  assert.equal(fs.readFileSync(file, 'utf-8'), '新しい');
  assert.equal(calls, 3);
});

test('atomicWriteFileSync: 存在しないフォルダも作る', (t) => {
  const file = path.join(tempDir(t), 'a', 'b', 'c.txt');
  atomicWriteFileSync(file, 'x');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'x');
});

test('atomicWriteFile(非同期): 書き込んで置き換える。失敗時は一時ファイルを残さない', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'b.txt');
  await atomicWriteFile(file, 'async-1');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'async-1');

  t.mock.method(fs.promises, 'rename', async () => {
    throw Object.assign(new Error('disk error'), { code: 'EIO' });
  });
  await assert.rejects(() => atomicWriteFile(file, 'async-2'), /disk error/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf-8'), 'async-1');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});
