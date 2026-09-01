/**
 * @file link-interceptor.js
 * @description 智能链接跳转捕获与拦截器（主世界注入桥接 + 隔离世界双层拦截，100% 免疫 SPA/Ember/Vue/React 路由劫持）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
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
    this.gestureOpenBudget = 0;
  }

  /**
   * 只把真实指针/键盘手势记为一次开标签额度。
   * HTMLElement.click() 在 Chrome 里 isTrusted 仍为 true，不能当手势；程序化点击没有 pointerdown。
   */
  initGestureGate() {
    const grant = () => {
      this.gestureOpenBudget = 1;
    };
    document.addEventListener('pointerdown', (event) => {
      if (event.isTrusted) grant();
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.isTrusted && (event.key === 'Enter' || event.key === ' ')) grant();
    }, true);
    document.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      queueMicrotask(() => {
        this.gestureOpenBudget = 0;
      });
    }, true);
  }

  /**
   * 每次真实手势最多开 1 个标签。公开自定义事件与隔离世界点击路径共用。
   * @returns {boolean} 是否允许本次开标签
   */
  shouldAllowOpenEvent() {
    if (this.gestureOpenBudget < 1) return false;
    this.gestureOpenBudget = 0;
    return true;
  }

  /**
   * 安全发送消息至后台（防御扩展重载导致的上下文失效报错）
   * @param {Object} message
   */
  safeSendMessage(message) {
    if (!chrome.runtime?.id) return;
    try {
      const chromeResult = chrome.runtime.sendMessage(message, () => {
        // 静默处理扩展重载上下文失效
        void chrome.runtime.lastError;
      });
      // MV3：传入 callback 时仍可能返回会拒绝的 Promise
      if (chromeResult != null && typeof chromeResult.then === 'function') {
        chromeResult.then(() => {}, () => {});
      }
    } catch {
      // 静默处理异常
    }
  }

  /**
   * 初始化拦截器，预加载规则并建立本地缓存与事件监听
   * @param {{ lightweight?: boolean }} [options] - lightweight=true 时（iframe 内）跳过
   *   DOM 全量扫描与悬浮预处理，仅保留点击拦截与主世界事件桥接
   */
  async init(options = {}) {
    if (this.isInitialized) return;

    await this.refreshRulesCache();
    if (!options.lightweight) {
      this.initHoverListener();
      this.initDOMObserver();
    }
    this.initGestureGate();
    this.initMainWorldEvents();
    this.initClickListener();
    this.syncModeToMainWorld();
    this.isInitialized = true;
  }

  /**
   * 监听来自主页面世界（Main World）的通信事件
   */
  initMainWorldEvents() {
    window.addEventListener('__BETTER_BROWSE_OPEN_NEW_TAB__', (event) => {
      const url = event?.detail?.url;
      if (!this.isSafeHttpUrl(url)) return;

      // 主世界只在 new 模式派发；隔离世界必须再查一次当前模式，防止 AUTO 下页面伪造开标签
      if (this.getEffectiveMode() !== LinkModes.NEW) return;

      if (this.lastHandledUrl === url && (Date.now() - this.lastHandledTime < 500)) {
        return;
      }

      if (!this.shouldAllowOpenEvent()) {
        return;
      }

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
    });
  }

  /**
   * 主世界事件属于公开页面 API，必须再次校验协议，防止页面脚本伪造特权 URL。
   * @param {unknown} rawUrl
   * @returns {boolean}
   */
  isSafeHttpUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !LinkMatcher.isInterceptionAllowed(rawUrl)) return false;
    try {
      const parsed = new URL(rawUrl, window.location.href);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
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
   * 向后台请求当前页最小必要跳转上下文（内容脚本不得直读 chrome.storage / IndexedDB）
   */
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
      if (data && typeof data === 'object') {
        this.linkRules = data.linkRules && typeof data.linkRules === 'object' ? data.linkRules : {};
        this.globalLinkRule = data.globalLinkRule || DefaultConfig.globalLinkRule || {
          enabled: false,
          mode: LinkModes.AUTO
        };
      }
    } catch {
      // 后台未就绪时保持现有内存缓存
    }
  }

  /**
   * 合并同步任务：后台 NOTIFY_RULE_UPDATED / NOTIFY_CONFIG_UPDATED 可能短时间内连发，
   * 防抖后只刷新一次主世界模式与页面链接
   */
  scheduleSync() {
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      this.syncModeToMainWorld();
      this.syncAllPageLinks();
    }, 150);
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
        if (!anchor.hasAttribute('data-bb-orig-rel')) {
          anchor.setAttribute('data-bb-orig-rel', rel || '__NONE__');
        }
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
      // 同步还原曾被追加的 rel 字段，避免 rel 残留改变站点原生行为
      if (anchor.hasAttribute('data-bb-orig-rel')) {
        const origRel = anchor.getAttribute('data-bb-orig-rel');
        if (origRel === '__NONE__') {
          anchor.removeAttribute('rel');
        } else {
          anchor.setAttribute('rel', origRel);
        }
        anchor.removeAttribute('data-bb-orig-rel');
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
    const formControl = targetElement.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    );
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
      // 若 500ms 内主世界或当前拦截器已处理过相同 URL 的打开操作，则阻止默认行为后忽略，
      // 杜绝重复开标签（该锚点已被 patch 为 target="_blank"，直接放行会触发浏览器原生开标签）
      if (this.lastHandledUrl === fullUrl && (Date.now() - this.lastHandledTime < 500)) {
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
        payload: {
          url: fullUrl,
          active: true
        }
      });
      return;
    }

    if (effectiveMode === LinkModes.CURRENT) {
      const currentTarget = (anchor.getAttribute('target') || '').toLowerCase();
      if (currentTarget === '_blank') {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.location.href = fullUrl;
        return;
      }
    }
  }
}
