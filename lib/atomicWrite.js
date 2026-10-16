'use strict';

const fs = require('fs');
const path = require('path');

// Windowsでは、ウイルス対策ソフトや検索インデクサがファイルを一瞬つかんでいて、
// rename が EPERM / EBUSY / EACCES で失敗することがある。短い間隔で数回やり直す。
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const MAX_ATTEMPTS = 6;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tempPathFor(file) {
  const dir = path.dirname(file);
  return path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
}

function renameWithRetrySync(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (!RETRYABLE.has(e.code) || attempt >= MAX_ATTEMPTS) throw e;
      sleepSync(25 * attempt);
    }
  }
}

/**
 * 同じフォルダの一時ファイルへ書き込み、fsync してから rename で置き換える。
 * 書き込みの途中でアプリやPCが落ちても、元のファイルは壊れない(中途半端なファイルが
 * 本来のファイル名で残ることがない)。失敗した場合は一時ファイルを消して例外を投げる。
 */
function atomicWriteFileSync(file, data, encoding = 'utf-8') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempPathFor(file);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data, 0, encoding);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    renameWithRetrySync(tmp, file);
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 既に閉じている */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* 一時ファイルが無い */ }
    throw e;
  }
}

/** 非同期版。処理の中身は同じ。 */
async function atomicWriteFile(file, data, encoding = 'utf-8') {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = tempPathFor(file);
  let handle;
  try {
    handle = await fs.promises.open(tmp, 'w');
    await handle.writeFile(data, encoding);
    await handle.sync();
    await handle.close();
    handle = undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.promises.rename(tmp, file);
        break;
      } catch (e) {
        if (!RETRYABLE.has(e.code) || attempt >= MAX_ATTEMPTS) throw e;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  } catch (e) {
    if (handle) {
      try { await handle.close(); } catch { /* 既に閉じている */ }
    }
    try { await fs.promises.unlink(tmp); } catch { /* 一時ファイルが無い */ }
    throw e;
  }
}

module.exports = { atomicWriteFileSync, atomicWriteFile };
