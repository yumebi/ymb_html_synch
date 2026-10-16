'use strict';

const fs = require('fs');
const { atomicWriteFileSync } = require('./atomicWrite');

// タイトルバー付近でつかめるとみなす、画面内に見えている最小の領域(DIP)。
const GRAB_WIDTH = 160;
const GRAB_HEIGHT = 40;
const SAVE_DELAY_MS = 600;

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 保存しておいたウインドウ位置を、現在のモニタ構成に合わせて補正する純粋関数。
 * モニタの取り外しや解像度の変更で、そのまま復元すると画面外に出て操作不能になるのを防ぐ。
 *
 * - 大きさは、全モニタを含む範囲を超えないようにし、最小サイズ未満にもしない
 * - タイトルバー付近がつかめる程度に見えていれば、モニタをまたぐ配置も含めてそのまま使う
 * - つかめない場合は、重なりが最も大きい(無ければ最も近い)モニタの中へ移す
 *
 * @param saved {x, y, width, height}
 * @param workAreas [{x, y, width, height}, ...] 各モニタの作業領域
 * @returns {x, y, width, height}。workAreas が空ならそのまま返す
 */
function fitBounds(saved, workAreas, { minWidth = 0, minHeight = 0 } = {}) {
  if (!workAreas || workAreas.length === 0) return { ...saved };

  const left = Math.min(...workAreas.map((a) => a.x));
  const top = Math.min(...workAreas.map((a) => a.y));
  const right = Math.max(...workAreas.map((a) => a.x + a.width));
  const bottom = Math.max(...workAreas.map((a) => a.y + a.height));
  const maxWidth = right - left;
  const maxHeight = bottom - top;

  const width = clamp(saved.width, Math.min(minWidth, maxWidth), maxWidth);
  const height = clamp(saved.height, Math.min(minHeight, maxHeight), maxHeight);
  const rect = { x: saved.x, y: saved.y, width, height };

  const strip = { x: rect.x, y: rect.y, width: rect.width, height: Math.min(GRAB_HEIGHT, rect.height) };
  const need = Math.min(GRAB_WIDTH, rect.width) * Math.min(GRAB_HEIGHT, rect.height);
  if (workAreas.some((a) => overlapArea(strip, a) >= need)) return rect;

  const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const distance = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const best = [...workAreas].sort((a, b) =>
    overlapArea(rect, b) - overlapArea(rect, a)
    || distance(center(rect), center(a)) - distance(center(rect), center(b)))[0];

  const w = Math.min(rect.width, best.width);
  const h = Math.min(rect.height, best.height);
  return {
    x: clamp(rect.x, best.x, best.x + best.width - w),
    y: clamp(rect.y, best.y, best.y + best.height - h),
    width: w,
    height: h,
  };
}

function isFiniteBounds(b) {
  return b
    && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))
    && b.width > 0 && b.height > 0;
}

/**
 * ウインドウの位置・大きさ・最大化の状態を保存して、次回の起動で復元する。
 * 保存は移動・サイズ変更の少し後(デバウンス)と、閉じるときに行う。終了時だけの保存だと、
 * 強制終了や再起動で直前の位置が失われる。書き込みは原子的(途中で落ちても壊れない)。
 *
 * @param file 保存先
 * @param defaultWidth / defaultHeight 保存が無いときの大きさ
 * @param minWidth / minHeight 最小サイズ
 * @param screen Electron の screen(テストでは差し替える)
 */
function createWindowStateKeeper({ file, defaultWidth, defaultHeight, minWidth = 0, minHeight = 0, screen }) {
  function load() {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { /* 初回、または読めない。既定を使う */ }

    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    if (isFiniteBounds(saved)) {
      const fitted = fitBounds(saved, workAreas, { minWidth, minHeight });
      return { ...fitted, isMaximized: Boolean(saved.isMaximized) };
    }

    // 保存が無い: プライマリの作業領域の中央に、既定の大きさで置く。
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(defaultWidth, area.width);
    const height = Math.min(defaultHeight, area.height);
    return {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
      isMaximized: Boolean(saved && saved.isMaximized),
    };
  }

  function manage(win) {
    let timer = null;

    const saveNow = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (win.isDestroyed() || win.isFullScreen()) return;
      try {
        // 最大化・最小化の最中でも、通常の状態の位置が取れる。
        const bounds = win.getNormalBounds();
        atomicWriteFileSync(file, JSON.stringify({ ...bounds, isMaximized: win.isMaximized() }));
      } catch (error) {
        console.warn('[windowState] 保存に失敗:', error.message);
      }
    };
    const scheduleSave = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(saveNow, SAVE_DELAY_MS);
    };

    for (const event of ['resize', 'move', 'maximize', 'unmaximize']) {
      win.on(event, scheduleSave);
    }
    win.on('close', saveNow);
    return { saveNow };
  }

  return { load, manage };
}

module.exports = { fitBounds, createWindowStateKeeper, GRAB_WIDTH, GRAB_HEIGHT };
