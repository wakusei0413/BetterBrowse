/**
 * @file link-interceptor.js
 * @description 智能链接跳转捕获与拦截器；自动模式不扫描 DOM、不监听悬浮、不启动 MutationObserver
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { LinkModes } from '../constants/config.js';
import { LinkMatcher } from '../core/link/link-matcher.js';

export class LinkInterceptor {
  constructor() {
    this.currentDomain = window.location.hostname.toLowerCase();
    this.effectiveMode = LinkModes.AUTO;
    this.isInitialized = false;
    this.isLightweight = false;
    this.lastHandledUrl = '';
    this.lastHandledTime = 0;
    this.gestureOpenBudget = 0;
    this.patchedAnchors = new Set();
    this.domObserver = null;
    this._enhancedDom = false;
    this._syncTimer = null;
    this._waitingForBody = false;

    this._handlePointerDown = (event) => {
      if (event.isTrusted) this.gestureOpenBudget = 1;
    };
    this._handleKeyDown = (event) => {
      if (event.isTrusted && (event.key === 'Enter' || event.key === ' ')) this.gestureOpenBudget = 1;
    };
    this._clearGestureBudget = (event) => {
      if (!event.isTrusted) return;
      queueMicrotask(() => {
        this.gestureOpenBudget = 0;
      });
    };
    this._handleClick = (event) => this.handleLinkClick(event);
    this._handleHover = (event) => {
      const anchor = event.target?.closest?.('a[href]');
      if (anchor) this.patchAnchorTarget(anchor);
    };
    this._handleMainWorldOpen = (event) => this.handleMainWorldOpen(event);
    this._startObserverAfterDomReady = () => {
      this._waitingForBody = false;
      if (this.effectiveMode !== LinkModes.AUTO) this.startDOMObserver();
    };
    this._destroyOnPageHide = () => this.destroy();
  }

  async init(options = {}) {
    if (this.isInitialized) return;
    this.isLightweight = Boolean(options.lightweight);

    await this.refreshRulesCache();
    this.initGestureGate();
    window.addEventListener('__BETTER_BROWSE_OPEN_NEW_TAB__', this._handleMainWorldOpen);
    document.addEventListener('click', this._handleClick, true);
    window.addEventListener('pagehide', this._destroyOnPageHide, { once: true });
    this.isInitialized = true;

    this.syncModeToMainWorld();
    this.applyModeResources({ initial: true });
  }

  initGestureGate() {
    document.addEventListener('pointerdown', this._handlePointerDown, true);
    document.addEventListener('keydown', this._handleKeyDown, true);
    document.addEventListener('click', this._clearGestureBudget, true);
  }

  shouldAllowOpenEvent() {
    if (this.gestureOpenBudget < 1) return false;
    this.gestureOpenBudget = 0;
    return true;
  }

  safeSendMessage(message) {
    if (!chrome.runtime?.id) return;
    try {
      const chromeResult = chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
      if (chromeResult != null && typeof chromeResult.then === 'function') {
        chromeResult.then(() => {}, () => {});
      }
    } catch {
      // 扩展重载后静默释放失效上下文
    }
  }

  handleMainWorldOpen(event) {
    const url = event?.detail?.url;
    if (!this.isSafeHttpUrl(url) || this.effectiveMode !== LinkModes.NEW) return;
    if (this.lastHandledUrl === url && Date.now() - this.lastHandledTime < 500) return;
    if (!this.shouldAllowOpenEvent()) return;

    this.lastHandledUrl = url;
    this.lastHandledTime = Date.now();
    this.safeSendMessage({
      action: ActionTypes.OPEN_TAB_BACKGROUND,
      payload: { url, active: true }
    });
  }

  isSafeHttpUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !LinkMatcher.isInterceptionAllowed(rawUrl)) return false;
    try {
      const parsed = new URL(rawUrl, window.location.href);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  syncModeToMainWorld() {
    const mode = this.effectiveMode;
    try {
      document.documentElement?.setAttribute('data-better-browse-mode', mode);
    } catch {
      // 忽略页面阻止属性写入的异常
    }
    window.dispatchEvent(new CustomEvent('__BETTER_BROWSE_SYNC_MODE__', { detail: { mode } }));
  }

  async refreshRulesCache() {
    if (!chrome.runtime?.id) return;
    try {
      const response = await new Promise((resolve) => {
        const chromeResult = chrome.runtime.sendMessage({ action: ActionTypes.GET_PAGE_LINK_CONTEXT }, (result) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(result);
        });
        if (chromeResult != null && typeof chromeResult.then === 'function') {
          chromeResult.then(() => {}, () => {});
        }
      });
      const data = response?.data || response;
      this.applyEffectiveMode(data?.effectiveMode || data);
      if (this.normalizeMode(this.effectiveMode)) return;

      // 兼容主线尚未切换到最小响应的过渡期；接入后此分支可删除。
      if (data && typeof data === 'object') {
        this.effectiveMode = LinkMatcher.resolveEffectiveMode({
          domain: data.domain || this.currentDomain,
          linkRules: data.linkRules && typeof data.linkRules === 'object' ? data.linkRules : {},
          globalLinkRule: data.globalLinkRule || { enabled: false, mode: LinkModes.AUTO }
        });
      }
    } catch {
      // 后台未就绪时保持当前内存模式
    }
  }

  normalizeMode(mode) {
    return mode === LinkModes.AUTO || mode === LinkModes.CURRENT || mode === LinkModes.NEW ? mode : null;
  }

  applyEffectiveMode(mode) {
    const normalized = this.normalizeMode(mode);
    if (normalized) this.effectiveMode = normalized;
  }

  scheduleSync() {
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      this.syncModeToMainWorld();
      this.applyModeResources();
    }, 150);
  }

  getEffectiveMode() {
    return this.effectiveMode;
  }

  applyModeResources({ initial = false } = {}) {
    if (this.isLightweight) return;

    if (this.effectiveMode === LinkModes.AUTO) {
      this.stopEnhancedDomHandling();
      return;
    }

    const wasInactive = !this.domObserver;
    this.startEnhancedDomHandling();
    if (initial || wasInactive) {
      this.syncAllPageLinks();
    } else {
      for (const anchor of [...this.patchedAnchors]) {
        if (!anchor?.isConnected) this.patchedAnchors.delete(anchor);
        else this.patchAnchorTarget(anchor);
      }
    }
  }

  startEnhancedDomHandling() {
    if (!this._enhancedDom) {
      document.addEventListener('mouseover', this._handleHover, { passive: true, capture: true });
      this._enhancedDom = true;
    }
    this.startDOMObserver();
  }

  stopEnhancedDomHandling() {
    if (this._enhancedDom) {
      document.removeEventListener('mouseover', this._handleHover, true);
      this._enhancedDom = false;
    }
    this.domObserver?.disconnect();
    this.domObserver = null;
    if (this._waitingForBody) {
      document.removeEventListener('DOMContentLoaded', this._startObserverAfterDomReady);
      this._waitingForBody = false;
    }
    for (const anchor of [...this.patchedAnchors]) this.restoreAnchor(anchor);
    this.patchedAnchors.clear();
  }

  startDOMObserver() {
    if (this.domObserver || this.effectiveMode === LinkModes.AUTO) return;
    if (!document.body) {
      if (!this._waitingForBody) {
        this._waitingForBody = true;
        document.addEventListener('DOMContentLoaded', this._startObserverAfterDomReady, { once: true });
      }
      return;
    }

    try {
      this.domObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) this.patchAddedNode(node);
        }
      });
      this.domObserver.observe(document.body, { childList: true, subtree: true });
    } catch (err) {
      console.warn('[LinkInterceptor] DOM 观察器启动异常:', err);
    }
  }

  patchAddedNode(node) {
    if (this.effectiveMode === LinkModes.AUTO || node?.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches?.('a[href]')) this.patchAnchorTarget(node);
    for (const anchor of node.querySelectorAll?.('a[href]') || []) this.patchAnchorTarget(anchor);
  }

  syncAllPageLinks() {
    if (this.effectiveMode === LinkModes.AUTO || this.isLightweight) return;
    for (const anchor of document.querySelectorAll('a[href]')) this.patchAnchorTarget(anchor);
  }

  patchAnchorTarget(anchor) {
    if (!anchor || this.effectiveMode === LinkModes.AUTO) return;
    const href = anchor.getAttribute('href');
    if (!LinkMatcher.isInterceptionAllowed(href)) return;

    if (!anchor.hasAttribute('data-bb-orig-target')) {
      anchor.setAttribute('data-bb-orig-target', anchor.getAttribute('target') || '__NONE__');
    }
    this.patchedAnchors.add(anchor);

    if (this.effectiveMode === LinkModes.NEW) {
      anchor.setAttribute('target', '_blank');
      const rel = anchor.getAttribute('rel') || '';
      if (!anchor.hasAttribute('data-bb-orig-rel')) {
        anchor.setAttribute('data-bb-orig-rel', rel || '__NONE__');
      }
      const relTokens = new Set(rel.split(/\s+/).filter(Boolean));
      relTokens.add('noopener');
      relTokens.add('noreferrer');
      anchor.setAttribute('rel', [...relTokens].join(' '));
      return;
    }

    anchor.setAttribute('target', '_self');
    this.restoreOriginalRel(anchor);
  }

  restoreOriginalRel(anchor) {
    if (!anchor.hasAttribute('data-bb-orig-rel')) return;
    const original = anchor.getAttribute('data-bb-orig-rel');
    if (original === '__NONE__') anchor.removeAttribute('rel');
    else anchor.setAttribute('rel', original);
  }

  restoreAnchor(anchor) {
    if (!anchor) return;
    if (anchor.hasAttribute('data-bb-orig-target')) {
      const original = anchor.getAttribute('data-bb-orig-target');
      if (original === '__NONE__') anchor.removeAttribute('target');
      else anchor.setAttribute('target', original);
      anchor.removeAttribute('data-bb-orig-target');
    }
    this.restoreOriginalRel(anchor);
    anchor.removeAttribute('data-bb-orig-rel');
  }

  handleLinkClick(event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (this.effectiveMode === LinkModes.AUTO) return;

    const targetElement = event.target;
    if (!targetElement || typeof targetElement.closest !== 'function') return;

    const formControl = targetElement.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    );
    if (formControl) return;

    const buttonEl = targetElement.closest('button');
    let anchor = targetElement.closest('a[href]');
    if (buttonEl && (!anchor || buttonEl.contains(anchor))) return;
    if (!anchor) {
      const topicRow = targetElement.closest('.topic-list-item, .topic-item');
      anchor = topicRow?.querySelector('a.title, a.raw-topic-link, a.topic-link, a[href]') || null;
    }
    if (!anchor) return;

    const rawHref = anchor.getAttribute('href');
    const fullUrl = anchor.href;
    if (!LinkMatcher.isInterceptionAllowed(rawHref) || !fullUrl || !LinkMatcher.isInterceptionAllowed(fullUrl)) return;

    try {
      const currentUrlNoHash = window.location.href.split('#')[0];
      const targetUrlNoHash = fullUrl.split('#')[0];
      if (currentUrlNoHash === targetUrlNoHash && rawHref.startsWith('#')) return;
    } catch {
      // 忽略 URL 比较异常
    }

    if (this.effectiveMode === LinkModes.NEW) {
      if (this.lastHandledUrl === fullUrl && Date.now() - this.lastHandledTime < 500) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!this.shouldAllowOpenEvent()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      this.lastHandledUrl = fullUrl;
      this.lastHandledTime = Date.now();
      event.preventDefault();
      event.stopImmediatePropagation();
      this.safeSendMessage({
        action: ActionTypes.OPEN_TAB_BACKGROUND,
        payload: { url: fullUrl, active: true }
      });
      return;
    }

    if ((anchor.getAttribute('target') || '').toLowerCase() === '_blank') {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.location.href = fullUrl;
    }
  }

  destroy() {
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    this.stopEnhancedDomHandling();
    document.removeEventListener('pointerdown', this._handlePointerDown, true);
    document.removeEventListener('keydown', this._handleKeyDown, true);
    document.removeEventListener('click', this._clearGestureBudget, true);
    document.removeEventListener('click', this._handleClick, true);
    window.removeEventListener('__BETTER_BROWSE_OPEN_NEW_TAB__', this._handleMainWorldOpen);
    window.removeEventListener('pagehide', this._destroyOnPageHide);
    this.isInitialized = false;
  }
}
