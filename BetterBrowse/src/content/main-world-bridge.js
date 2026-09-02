/**
 * @file main-world-bridge.js
 * @description 主页面世界链接拦截桥接；自动模式下释放点击拦截与 window.open 包装
 * @encoding UTF-8
 */

(function () {
  'use strict';

  if (window.__BETTER_BROWSE_MAIN_WORLD_LOADED__) return;
  window.__BETTER_BROWSE_MAIN_WORLD_LOADED__ = true;

  let currentEffectiveMode = 'auto';
  let modeObserver = null;
  let bridgeActive = false;
  const originalWindowOpen = window.open;

  function normalizeMode(mode) {
    return mode === 'auto' || mode === 'current' || mode === 'new' ? mode : null;
  }

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

  function findTargetAnchor(target) {
    if (!target || typeof target.closest !== 'function') return null;

    const formControl = target.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    );
    if (formControl) return null;

    const buttonEl = target.closest('button');
    const anchor = target.closest('a[href]');
    if (buttonEl && (!anchor || buttonEl.contains(anchor))) return null;
    if (anchor) return anchor;

    const topicRow = target.closest('.topic-list-item, .topic-item');
    return topicRow?.querySelector('a.title, a.raw-topic-link, a.topic-link, a[href]') || null;
  }

  function handleMainWorldClick(event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;

    const anchor = findTargetAnchor(event.target);
    if (!anchor) return;

    const rawHref = anchor.getAttribute('href');
    if (!isAllowedUrl(rawHref)) return;

    const fullUrl = anchor.href;
    if (!fullUrl || !isAllowedUrl(fullUrl)) return;

    try {
      const currentNoHash = window.location.href.split('#')[0];
      const targetNoHash = fullUrl.split('#')[0];
      if (currentNoHash === targetNoHash && rawHref.startsWith('#')) return;
    } catch {
      // 忽略 URL 比较异常
    }

    if (currentEffectiveMode === 'new') {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.dispatchEvent(new CustomEvent('__BETTER_BROWSE_OPEN_NEW_TAB__', {
        detail: { url: fullUrl }
      }));
      return;
    }

    if (currentEffectiveMode === 'current') {
      const targetAttr = (anchor.getAttribute('target') || '').toLowerCase();
      if (targetAttr === '_blank') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        window.location.href = fullUrl;
      }
    }
  }

  function wrappedWindowOpen(url, target, features) {
    if (currentEffectiveMode === 'current' && url && isAllowedUrl(url)) {
      const requestedTarget = typeof target === 'string' ? target.toLowerCase() : '';
      if (!requestedTarget || requestedTarget === '_self') {
        window.location.href = new URL(url, window.location.href).href;
        return window;
      }
    }
    return originalWindowOpen.call(this, url, target, features);
  }

  function activateBridge() {
    if (bridgeActive) return;
    window.addEventListener('click', handleMainWorldClick, true);
    window.open = wrappedWindowOpen;
    bridgeActive = true;
  }

  function deactivateBridge() {
    if (!bridgeActive) return;
    window.removeEventListener('click', handleMainWorldClick, true);
    if (window.open === wrappedWindowOpen) window.open = originalWindowOpen;
    bridgeActive = false;
  }

  function applyMode(mode) {
    const normalized = normalizeMode(mode);
    if (!normalized) return;
    currentEffectiveMode = normalized;
    if (normalized === 'auto') deactivateBridge();
    else activateBridge();
  }

  function readModeAttribute() {
    return normalizeMode(document.documentElement?.getAttribute('data-better-browse-mode'));
  }

  function initModeObserver() {
    if (!document.documentElement || modeObserver) return;
    applyMode(readModeAttribute() || currentEffectiveMode);
    modeObserver = new MutationObserver(() => {
      const mode = readModeAttribute();
      if (mode && mode !== currentEffectiveMode) applyMode(mode);
    });
    modeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-better-browse-mode']
    });
  }

  function handleModeSync(event) {
    applyMode(event?.detail?.mode);
  }

  function destroyBridge() {
    deactivateBridge();
    modeObserver?.disconnect();
    modeObserver = null;
    window.removeEventListener('__BETTER_BROWSE_SYNC_MODE__', handleModeSync);
    window.removeEventListener('pagehide', destroyBridge);
    document.removeEventListener('DOMContentLoaded', initModeObserver);
  }

  window.addEventListener('__BETTER_BROWSE_SYNC_MODE__', handleModeSync);
  window.addEventListener('pagehide', destroyBridge, { once: true });

  if (document.documentElement) initModeObserver();
  else document.addEventListener('DOMContentLoaded', initModeObserver, { once: true });
})();
