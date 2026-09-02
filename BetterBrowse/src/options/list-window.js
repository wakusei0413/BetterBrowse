/**
 * @file list-window.js
 * @description 选项页收纳列表虚拟窗口纯函数（组卡片高度估算、主列可见范围、组内条目切片）
 * @encoding UTF-8
 */

/** 未展开组默认露出的条目数 */
export const TABS_INITIAL_LIMIT = 25;

/** 组窗口上下额外挂载的卡片数 */
export const GROUP_OVERSCAN = 8;

/** 条目窗口上下额外挂载的行数 */
export const TAB_OVERSCAN = 20;

/**
 * 按展示密度返回行高与间距（与 options.css 中 max-height / gap / margin 对齐）
 * @param {boolean} compact
 * @returns {{ rowHeight: number, headerHeight: number, gap: number, showMoreHeight: number }}
 */
export function getDensityMetrics(compact) {
  if (compact) {
    return {
      rowHeight: 32,
      headerHeight: 54,
      gap: 10,
      showMoreHeight: 40
    };
  }
  return {
    rowHeight: 44,
    headerHeight: 78,
    gap: 16,
    showMoreHeight: 42
  };
}

/**
 * 估算一张收纳组卡片的内容高度（不含组间距）
 * @param {{ itemCount?: number, expanded?: boolean, compact?: boolean, visibleItemCount?: number }} options
 * @returns {number}
 */
export function estimateGroupCardHeight(options = {}) {
  const compact = Boolean(options.compact);
  const metrics = getDensityMetrics(compact);
  const itemCount = Math.max(0, Math.floor(Number(options.itemCount) || 0));
  let rows;
  let showMore = 0;
  if (Number.isFinite(options.visibleItemCount)) {
    rows = Math.max(0, Math.floor(options.visibleItemCount));
  } else if (options.expanded || itemCount <= TABS_INITIAL_LIMIT) {
    rows = itemCount;
  } else {
    rows = TABS_INITIAL_LIMIT;
    showMore = metrics.showMoreHeight;
  }
  return metrics.headerHeight + rows * metrics.rowHeight + showMore;
}

/**
 * 由各段高度累加出 spacer
 * @param {number[]} sizes
 * @param {number} start
 * @param {number} end
 * @returns {{ padTop: number, padBottom: number }}
 */
export function computePads(sizes, start, end) {
  const list = Array.isArray(sizes) ? sizes : [];
  const safeStart = Math.max(0, Math.min(list.length, Math.floor(Number(start) || 0)));
  const safeEnd = Math.max(safeStart, Math.min(list.length, Math.floor(Number(end) || 0)));
  let padTop = 0;
  for (let i = 0; i < safeStart; i++) padTop += list[i] || 0;
  let padBottom = 0;
  for (let i = safeEnd; i < list.length; i++) padBottom += list[i] || 0;
  return { padTop, padBottom };
}

/**
 * 根据滚动位置计算应挂载的闭开区间 [start, end)
 * @param {{ scrollTop: number, viewportHeight: number, sizes: number[], overscan?: number }} options
 * @returns {{ start: number, end: number, padTop: number, padBottom: number }}
 */
export function getVisibleRange(options = {}) {
  const sizes = Array.isArray(options.sizes) ? options.sizes : [];
  const count = sizes.length;
  if (count === 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }

  const scrollTop = Math.max(0, Number(options.scrollTop) || 0);
  const viewportHeight = Math.max(0, Number(options.viewportHeight) || 0);
  const overscan = Math.max(0, Math.floor(Number(options.overscan) || 0));
  const viewBottom = scrollTop + viewportHeight;

  let offset = 0;
  let start = 0;
  for (let i = 0; i < count; i++) {
    const next = offset + (sizes[i] || 0);
    if (next > scrollTop) {
      start = i;
      break;
    }
    offset = next;
    start = i;
  }

  let acc = 0;
  let end = count;
  for (let i = 0; i < count; i++) {
    acc += sizes[i] || 0;
    if (i >= start && acc >= viewBottom) {
      end = i + 1;
      break;
    }
  }

  start = Math.max(0, start - overscan);
  end = Math.min(count, end + overscan);
  const pads = computePads(sizes, start, end);
  return { start, end, padTop: pads.padTop, padBottom: pads.padBottom };
}

/**
 * 计算组内条目在主列视口中应挂载的行窗口
 * @param {{ listTop: number, scrollTop: number, viewportHeight: number, itemCount: number, rowHeight: number, overscan?: number }} options
 * @returns {{ start: number, end: number, padTop: number, padBottom: number }}
 */
export function getItemWindow(options = {}) {
  const itemCount = Math.max(0, Math.floor(Number(options.itemCount) || 0));
  const rowHeight = Math.max(1, Number(options.rowHeight) || 1);
  if (itemCount === 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }

  const listTop = Number(options.listTop) || 0;
  const scrollTop = Math.max(0, Number(options.scrollTop) || 0);
  const viewportHeight = Math.max(0, Number(options.viewportHeight) || 0);
  const overscan = Math.max(0, Math.floor(Number(options.overscan) || 0));
  const viewTop = scrollTop;
  const viewBottom = scrollTop + viewportHeight;
  const listHeight = itemCount * rowHeight;
  const listBottom = listTop + listHeight;

  if (listBottom <= viewTop || listTop >= viewBottom) {
    return { start: 0, end: 0, padTop: 0, padBottom: listHeight };
  }

  const startUnclamped = Math.floor((viewTop - listTop) / rowHeight);
  const endUnclamped = Math.ceil((viewBottom - listTop) / rowHeight);
  const start = Math.max(0, startUnclamped - overscan);
  const end = Math.min(itemCount, Math.max(start, endUnclamped + overscan));
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (itemCount - end) * rowHeight
  };
}
