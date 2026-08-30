/**
 * @file main-world-bridge.js
 * @description 主页面世界（Main World）强力拦截桥接脚本（100% 免疫 SPA/Ember/Vue/React 路由劫持，无任何不安全 DOM 注入）
 * @encoding UTF-8
 */

(function () {
  'use strict';

  // 避免重复注入
  if (window.__BETTER_BROWSE_MAIN_WORLD_LOADED__) return;
  window.__BETTER_BROWSE_MAIN_WORLD_LOADED__ = true;

  let currentEffectiveMode = document.documentElement?.getAttribute('data-better-browse-mode') || 'auto'; // 'auto' | 'current' | 'new'

  /**
   * 校验模式值合法性：事件与 DOM 属性均为页面脚本可触碰的公开通道，
   * 必须做枚举白名单校验，防止页面注入任意字符串篡改拦截行为
   * @param {unknown} mode
   * @returns {string|null}
   */
  function normalizeMode(mode) {
    return mode === 'auto' || mode === 'current' || mode === 'new' ? mode : null;
  }

  /**
   * 1. 监听来自隔离世界的自定义模式同步事件
   */
  window.addEventListener('__BETTER_BROWSE_SYNC_MODE__', (event) => {
    const mode = normalizeMode(event?.detail?.mode);
    if (mode) {
      currentEffectiveMode = mode;
    }
  });

  /**
   * 2. 监听 DOM 根节点 data-better-browse-mode 属性变更（零事件丢失保障）
   */
  const initModeObserver = () => {
    if (!document.documentElement) return;
    const initialAttr = normalizeMode(document.documentElement.getAttribute('data-better-browse-mode'));
    if (initialAttr) currentEffectiveMode = initialAttr;

    const observer = new MutationObserver(() => {
      const mode = normalizeMode(document.documentElement.getAttribute('data-better-browse-mode'));
      if (mode && mode !== currentEffectiveMode) {
        currentEffectiveMode = mode;
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-better-browse-mode'] });
  };

  if (document.documentElement) {
    initModeObserver();
  } else {
    document.addEventListener('DOMContentLoaded', initModeObserver, { once: true });
  }

  /**
   * 判定链接是否合法且允许拦截
   * @param {string} url
   */
  function isAllowedUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed || trimmed === '#' || trimmed.startsWith('#') || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
    try {
      const parsed = new URL(trimmed, window.location.href);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * 查找目标点击对应的超链接元素（精准识别，避免漏网或误杀）
   * @param {EventTarget} target
   * @returns {HTMLAnchorElement | null}
   */
  function findTargetAnchor(target) {
    if (!target || typeof target.closest !== 'function') return null;

    // 1. 如果点击的是原生表单输入控件（input/textarea/select/可编辑区），不拦截
    const formControl = target.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    );
    if (formControl) return null;

    // 2. 如果点击的是原生 <button> 且不在 <a> 标签内，不拦截
    const buttonEl = target.closest('button');
    const anchor = target.closest('a[href]');
    if (buttonEl && (!anchor || buttonEl.contains(anchor))) {
      return null;
    }

    // 3. 命中超链接元素
    if (anchor) return anchor;

    // 4. 论坛主题列表行兼容（如 Discourse / NodeBB 特征行）
    const topicRow = target.closest('.topic-list-item, .topic-item');
    if (topicRow) {
      const rowAnchor = topicRow.querySelector('a.title, a.raw-topic-link, a.topic-link, a[href]');
      if (rowAnchor) return rowAnchor;
    }

    return null;
  }

  /**
   * 在主世界捕获阶段进行全局点击拦截
   */
  function handleMainWorldClick(event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    if (currentEffectiveMode === 'auto') {
      return;
    }

    const anchor = findTargetAnchor(event.target);
    if (!anchor) return;

    const rawHref = anchor.getAttribute('href');
    if (!isAllowedUrl(rawHref)) return;

    const fullUrl = anchor.href;
    if (!fullUrl || !isAllowedUrl(fullUrl)) return;

    // 排除同页面纯锚点滚动
    try {
      const currentNoHash = window.location.href.split('#')[0];
      const targetNoHash = fullUrl.split('#')[0];
      if (currentNoHash === targetNoHash && rawHref.startsWith('#')) {
        return;
      }
    } catch {
      // 忽略比较异常
    }

    // === 新标签页模式 (NEW) ===
    if (currentEffectiveMode === 'new') {
      // 强力阻断主页面内 SPA 路由（如 Discourse Ember Router / React）
      event.preventDefault();
      event.stopImmediatePropagation();

      // 通知隔离世界创建新标签页
      window.dispatchEvent(
        new CustomEvent('__BETTER_BROWSE_OPEN_NEW_TAB__', {
          detail: { url: fullUrl }
        })
      );
      return;
    }

    // === 当前标签页模式 (CURRENT) ===
    if (currentEffectiveMode === 'current') {
      const targetAttr = (anchor.getAttribute('target') || '').toLowerCase();
      if (targetAttr === '_blank') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        window.location.href = fullUrl;
        return;
      }
    }
  }

  // 注册全局顶层事件捕获（window 捕获阶段优先于任何 DOM 子节点）
  window.addEventListener('click', handleMainWorldClick, true);

  // 劫持 window.open
  const originalWindowOpen = window.open;
  window.open = function (url, target, features) {
    if (currentEffectiveMode === 'current' && url && isAllowedUrl(url)) {
      const requestedTarget = typeof target === 'string' ? target.toLowerCase() : '';
      // 仅劫持"当前页打开"语义的调用；
      // _top/_parent 与具名窗口/iframe 目标保持站点原生行为，
      // 强制改写会破坏站点弹窗、OAuth 登录与页内框架导航
      if (!requestedTarget || requestedTarget === '_self') {
        window.location.href = new URL(url, window.location.href).href;
        return window;
      }
    }
    return originalWindowOpen.apply(this, arguments);
  };
})();
