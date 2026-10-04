/**
 * @file stash-favicons.js
 * @description 时间线站点图标解析：经后台代取 data URL 替换占位 SVG，避免页面直连第三方
 * @encoding UTF-8
 */

import { ActionTypes } from '../../constants/action-types.js';
import { MessageBus } from '../../core/bus/message-bus.js';

export class FaviconResolver {
  /**
   * @param {() => HTMLElement | null} getContainer - 时间线列表容器
   */
  constructor(getContainer) {
    this.getContainer = getContainer;
    /** @type {Map<string, string | null>} URL → data URL（null 表示取回失败） */
    this.cache = new Map();
    /** @type {Set<string>} 正在取回的 URL（同 URL 并发合并） */
    this.inFlight = new Set();
  }

  get container() {
    return this.getContainer();
  }

  /**
   * 批量解析当前可见行的站点图标：经后台取回 data URL 后替换占位 SVG，避免直连第三方
   *
   * ⚠️ 两个易错点：
   * 1. MessageBus 会把后台结果统一包装成 { success, data }，因此图标字段在 res.data.dataUrl，
   *    直接读 res.dataUrl 恒为 undefined（图标永远替换不掉、全部停留在默认占位图标）。
   * 2. 组内条目是 prefetchVisiblePages 异步分页填充的，同步渲染路径上调用本方法时行尚未挂载，
   *    必须在异步分页的 .then 回补里再次调用（见 prefetchVisiblePages）。
   */
  async resolveVisible() {
    const placeholders = this.container?.querySelectorAll('svg.tab-favicon-fallback[data-favicon-url]:not([data-resolved])');
    if (!placeholders || placeholders.length === 0) return;
    const limit = 24;
    let count = 0;
    for (const svg of placeholders) {
      if (count >= limit) break;
      const url = svg.getAttribute('data-favicon-url') || '';
      if (!url) continue;
      svg.setAttribute('data-resolved', '1');
      count += 1;
      this.applyFavicon(svg, url, svg.getAttribute('data-page-url') || '');
    }
  }

  /**
   * 应用单个站点图标：命中缓存直接替换，否则经后台代取（同 URL 并发合并）
   * @param {SVGElement} svg - 占位图标元素
   * @param {string} url - 网页或图标 URL
   * @param {string} [pageUrl] - 页面对应的 http(s) 地址，用于按站点域名回退
   */
  async applyFavicon(svg, url, pageUrl = '') {
    if (this.cache.has(url)) {
      const cached = this.cache.get(url);
      if (cached) this.replaceFaviconPlaceholder(svg, cached);
      return;
    }
    if (this.inFlight.has(url)) return;
    this.inFlight.add(url);
    try {
      const res = await MessageBus.sendToBackground(ActionTypes.RESOLVE_FAVICON_DATA_URL, {
        url,
        pageUrl
      });
      // 后台返回值被 MessageBus 包装在 data 中：{ success: true, data: { success, dataUrl } }
      const payload = res?.data || {};
      const dataUrl = res?.success && payload.success ? payload.dataUrl : '';
      this.cache.set(url, dataUrl || null);
      if (!dataUrl) return;
      // 缓存命中批量回填：同一 URL 可能在多个组里重复出现
      for (const node of this.container?.querySelectorAll(`svg.tab-favicon-fallback[data-favicon-url="${CSS.escape(url)}"]`) || []) {
        this.replaceFaviconPlaceholder(node, dataUrl);
      }
    } catch {
      this.cache.set(url, null);
    } finally {
      this.inFlight.delete(url);
    }
  }

  /**
   * 将占位 SVG 替换为真实图标 <img>，失败时由 error 委托自动回退默认图标
   * @param {SVGElement} svg
   * @param {string} dataUrl
   */
  replaceFaviconPlaceholder(svg, dataUrl) {
    if (!svg?.isConnected) return;
    const img = document.createElement('img');
    img.src = dataUrl;
    img.className = 'tab-favicon';
    img.alt = '';
    img.decoding = 'async';
    svg.replaceWith(img);
  }
}
