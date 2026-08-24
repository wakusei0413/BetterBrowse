/**
 * @file link-interceptor.js
 * @description 智能链接跳转捕获与拦截器（主世界注入桥接 + 隔离世界双层拦截，100% 免疫 SPA/Ember/Vue/React 路由劫持）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { StorageKeys } from '../constants/storage-keys.js';
import { LinkModes, DefaultConfig } from '../constants/config.js';
import { LinkMatcher } from '../core/link/link-matcher.js';

export class LinkInterceptor {
  constructor() {
    this.currentDomain = window.location.hostname.toLowerCase();
    this.linkRules = {};
    this.globalLinkRule = { enabled: false, mode: LinkModes.AUTO };
    this.isInitialized = false;
    this.lastHandledUrl = '';
    this.lastHandledTime = 0;
  }

  /**
   * 安全发送消息至后台（防御扩展重载导致的上下文失效报错）
   * @param {Object} message
   */
  safeSendMessage(message) {
    if (!chrome.runtime?.id) return;
    try {
      chrome.runtime.sendMessage(message, () => {
        if (chrome.runtime.lastError) {
          // 静默处理扩展重载上下文失效
        }
      });
    } catch {
      // 静默处理异常
    }
  }

  /**
   * 初始化拦截器，预加载规则并建立本地缓存与事件监听
   */
  async init() {
    if (this.isInitialized) return;

    await this.refreshRulesCache();
    this.initStorageListener();
    this.initMainWorldEvents();
    this.initClickListener();
    this.initHoverListener();
    this.initDOMObserver();
    this.syncModeToMainWorld();
    this.isInitialized = true;
  }

  /**
   * 监听来自主页面世界（Main World）的通信事件
   */
  initMainWorldEvents() {
    window.addEventListener('__BETTER_BROWSE_OPEN_NEW_TAB__', (event) => {
      const url = event?.detail?.url;
      if (url) {
        // 记录已由主世界拦截并处理的时间戳与 URL，彻底杜绝隔离世界二次重复发送消息
        this.lastHandledUrl = url;
        this.lastHandledTime = Date.now();

        this.safeSendMessage({
          action: ActionTypes.OPEN_TAB_BACKGROUND,
          payload: {
            url: url,
            active: true
          }
        });
      }
    });
  }

  /**
   * 将当前生效模式同步至主世界桥接器（CustomEvent + DOM dataset 双重通道）
   */
  syncModeToMainWorld() {
    const mode = this.getEffectiveMode();
    try {
      document.documentElement?.setAttribute('data-better-browse-mode', mode);
    } catch {
      // 忽略 DOM 操作异常
    }

    window.dispatchEvent(
      new CustomEvent('__BETTER_BROWSE_SYNC_MODE__', {
        detail: { mode }
      })
    );
  }

  /**
   * 从 Storage 刷新内存规则缓存
   */
  async refreshRulesCache() {
    return new Promise((resolve) => {
      if (!chrome.runtime?.id || !chrome.storage?.local) {
        resolve();
        return;
      }
      try {
        chrome.storage.local.get([StorageKeys.LINK_RULES, StorageKeys.USER_CONFIG], (result) => {
          if (!chrome.runtime.lastError && result) {
            this.linkRules = result[StorageKeys.LINK_RULES] || {};
            const config = result[StorageKeys.USER_CONFIG] || DefaultConfig;
            this.globalLinkRule = config.globalLinkRule || { enabled: false, mode: LinkModes.AUTO };
          }
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  /**
   * 监听规则更新以实现即时同步（零刷新即时生效）
   */
  initStorageListener() {
    if (!chrome.runtime?.id || !chrome.storage?.onChanged) return;
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (!chrome.runtime?.id) return;
        if (areaName !== 'local') return;

        let changed = false;
        if (changes[StorageKeys.LINK_RULES]) {
          this.linkRules = changes[StorageKeys.LINK_RULES].newValue || {};
          changed = true;
        }
        if (changes[StorageKeys.USER_CONFIG]) {
          const newConfig = changes[StorageKeys.USER_CONFIG].newValue || {};
          this.globalLinkRule = newConfig.globalLinkRule || { enabled: false, mode: LinkModes.AUTO };
          changed = true;
        }

        if (changed) {
          this.syncModeToMainWorld();
          this.syncAllPageLinks();
        }
      });
    } catch {
      // 忽略监听异常
    }
  }

  /**
   * 获取当前页面最终生效的跳转模式
   * @returns {'auto' | 'current' | 'new'}
   */
  getEffectiveMode() {
    return LinkMatcher.resolveEffectiveMode({
      domain: this.currentDomain,
      linkRules: this.linkRules,
      globalLinkRule: this.globalLinkRule
    });
  }

  /**
   * 绑定捕获阶段（Capture Phase）点击事件监听
   */
  initClickListener() {
    document.addEventListener(
      'click',
      (event) => {
        this.handleLinkClick(event);
      },
      true // 捕获阶段拦截
    );
  }

  /**
   * 绑定鼠标悬浮预处理，提前修正 target 属性
   */
  initHoverListener() {
    document.addEventListener(
      'mouseover',
      (event) => {
        const anchor = event.target?.closest?.('a[href]');
        if (anchor) {
          this.patchAnchorTarget(anchor);
        }
      },
      { passive: true, capture: true }
    );
  }

  /**
   * 监听 DOM 动态插入的超链接节点
   */
  initDOMObserver() {
    try {
      const observer = new MutationObserver(() => {
        if (this._observerTimer) return;
        this._observerTimer = setTimeout(() => {
          this.syncAllPageLinks();
          this._observerTimer = null;
        }, 500);
      });

      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
          }
        });
      }
    } catch (err) {
      console.warn('[LinkInterceptor] DOM 观察器启动异常:', err);
    }
  }

  /**
   * 批量同步页面中所有超链接属性（支持无损动态还原）
   */
  syncAllPageLinks() {
    const links = document.querySelectorAll('a[href]');
    for (const a of links) {
      this.patchAnchorTarget(a);
    }
  }

  /**
   * 修正单个超链接的 DOM 属性（支持可逆还原原始 target）
   * @param {HTMLAnchorElement} anchor
   */
  patchAnchorTarget(anchor) {
    const href = anchor.getAttribute('href');
    if (!LinkMatcher.isInterceptionAllowed(href)) return;

    const mode = this.getEffectiveMode();
    if (mode === LinkModes.NEW) {
      if (!anchor.hasAttribute('data-bb-orig-target')) {
        anchor.setAttribute('data-bb-orig-target', anchor.getAttribute('target') || '__NONE__');
      }
      anchor.setAttribute('target', '_blank');
      const rel = anchor.getAttribute('rel') || '';
      if (!rel.includes('noopener')) {
        anchor.setAttribute('rel', (rel ? rel + ' ' : '') + 'noopener noreferrer');
      }
    } else if (mode === LinkModes.CURRENT) {
      if (!anchor.hasAttribute('data-bb-orig-target')) {
        anchor.setAttribute('data-bb-orig-target', anchor.getAttribute('target') || '__NONE__');
      }
      anchor.setAttribute('target', '_self');
    } else if (mode === LinkModes.AUTO) {
      if (anchor.hasAttribute('data-bb-orig-target')) {
        const orig = anchor.getAttribute('data-bb-orig-target');
        if (orig === '__NONE__') {
          anchor.removeAttribute('target');
        } else {
          anchor.setAttribute('target', orig);
        }
        anchor.removeAttribute('data-bb-orig-target');
      }
    }
  }

  /**
   * 处理超链接点击核心拦截逻辑（隔离世界备用）
   * @param {MouseEvent} event
   */
  handleLinkClick(event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const targetElement = event.target;
    if (!targetElement || typeof targetElement.closest !== 'function') return;

    // 1. 过滤原生表单控件与原生 button（除非包含在 a[href] 中）
    const formControl = targetElement.closest('input, textarea, select, [contenteditable="true"]');
    if (formControl) return;

    const buttonEl = targetElement.closest('button');
    let anchor = targetElement.closest('a[href]');
    if (buttonEl && (!anchor || buttonEl.contains(anchor))) {
      return;
    }

    if (!anchor) {
      const topicRow = targetElement.closest('.topic-list-item, .topic-item');
      if (topicRow) {
        anchor = topicRow.querySelector('a.title, a.raw-topic-link, a.topic-link, a[href]');
      }
    }

    if (!anchor) return;

    const rawHref = anchor.getAttribute('href');
    if (!LinkMatcher.isInterceptionAllowed(rawHref)) {
      return;
    }

    const fullUrl = anchor.href;
    if (!fullUrl || !LinkMatcher.isInterceptionAllowed(fullUrl)) {
      return;
    }

    try {
      const currentUrlNoHash = window.location.href.split('#')[0];
      const targetUrlNoHash = fullUrl.split('#')[0];
      if (currentUrlNoHash === targetUrlNoHash && rawHref.startsWith('#')) {
        return;
      }
    } catch {
      // 忽略比较异常
    }

    const effectiveMode = this.getEffectiveMode();

    if (effectiveMode === LinkModes.AUTO) {
      return;
    }

    if (effectiveMode === LinkModes.NEW) {
      // 若 500ms 内主世界或当前拦截器已处理过相同 URL 的打开操作，则直接忽略，杜绝重复开标签
      if (this.lastHandledUrl === fullUrl && (Date.now() - this.lastHandledTime < 500)) {
        return;
      }
      this.lastHandledUrl = fullUrl;
      this.lastHandledTime = Date.now();

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      this.safeSendMessage({
        action: ActionTypes.OPEN_TAB_BACKGROUND,
        payload: {
          url: fullUrl,
          active: true
        }
      });
      return;
    }

    if (effectiveMode === LinkModes.CURRENT) {
      const currentTarget = (anchor.getAttribute('target') || '').toLowerCase();
      if (currentTarget === '_blank' || anchor.target === '_blank') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        window.location.href = fullUrl;
        return;
      }
    }
  }
}
