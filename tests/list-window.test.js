/**
 * @file list-window.test.js
 * @description 选项页虚拟窗口纯函数：高度估算、可见范围与组内条目切片
 * @encoding UTF-8
 */

import { assertEquals } from "@std/assert";
import {
  TABS_INITIAL_LIMIT,
  computePads,
  estimateGroupCardHeight,
  getDensityMetrics,
  getItemWindow,
  getVisibleRange
} from "../BetterBrowse/src/options/list-window.js";

Deno.test("estimateGroupCardHeight：未展开超长组只按初始条数 + 展开按钮", () => {
  const compact = getDensityMetrics(false);
  const height = estimateGroupCardHeight({ itemCount: 1000, expanded: false, compact: false });
  const expected = compact.headerHeight + TABS_INITIAL_LIMIT * compact.rowHeight + compact.showMoreHeight;
  assertEquals(height, expected);
});

Deno.test("estimateGroupCardHeight：展开后按全部条目估算", () => {
  const compact = getDensityMetrics(true);
  const height = estimateGroupCardHeight({ itemCount: 80, expanded: true, compact: true });
  assertEquals(height, compact.headerHeight + 80 * compact.rowHeight);
});

Deno.test("estimateGroupCardHeight：visibleItemCount 覆盖默认截断", () => {
  const metrics = getDensityMetrics(false);
  const height = estimateGroupCardHeight({
    itemCount: 1000,
    expanded: false,
    compact: false,
    visibleItemCount: 3
  });
  assertEquals(height, metrics.headerHeight + 3 * metrics.rowHeight);
});

Deno.test("getVisibleRange：只返回视口附近区间并保留 overscan 与 spacer", () => {
  const sizes = Array.from({ length: 20 }, () => 100);
  const range = getVisibleRange({
    scrollTop: 500,
    viewportHeight: 200,
    sizes,
    overscan: 2
  });
  assertEquals(range.start, 3);
  assertEquals(range.end, 9);
  assertEquals(range.padTop, 300);
  assertEquals(range.padBottom, 1100);
});

Deno.test("getVisibleRange：空列表与 overscan 不越界", () => {
  assertEquals(getVisibleRange({ scrollTop: 0, viewportHeight: 400, sizes: [] }), {
    start: 0,
    end: 0,
    padTop: 0,
    padBottom: 0
  });
  const tiny = getVisibleRange({
    scrollTop: 0,
    viewportHeight: 800,
    sizes: [40, 40],
    overscan: 8
  });
  assertEquals(tiny.start, 0);
  assertEquals(tiny.end, 2);
  assertEquals(tiny.padTop, 0);
  assertEquals(tiny.padBottom, 0);
});

Deno.test("computePads 与 getItemWindow：组内虚拟行的 spacer 连续", () => {
  assertEquals(computePads([10, 20, 30, 40], 1, 3), { padTop: 10, padBottom: 40 });

  const window = getItemWindow({
    listTop: 100,
    scrollTop: 300,
    viewportHeight: 200,
    itemCount: 1000,
    rowHeight: 40,
    overscan: 2
  });
  assertEquals(window.start, 3);
  assertEquals(window.end, 12);
  assertEquals(window.padTop, 120);
  assertEquals(window.padBottom, (1000 - 12) * 40);
});

Deno.test("getItemWindow：列表完全在视口外时不挂载行", () => {
  const hidden = getItemWindow({
    listTop: 2000,
    scrollTop: 0,
    viewportHeight: 400,
    itemCount: 50,
    rowHeight: 40,
    overscan: 5
  });
  assertEquals(hidden.start, 0);
  assertEquals(hidden.end, 0);
  assertEquals(hidden.padBottom, 50 * 40);
});
