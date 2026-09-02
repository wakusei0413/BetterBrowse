/**
 * @file index.js
 * @description 内容脚本总入口（初始化链接拦截器与表单状态监听）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { LinkInterceptor } from './link-interceptor.js';
import { FormDetector } from './form-detector.js';
import { CountdownBanner } from './countdown-banner.js';
import { installRuntimeLogger } from '../core/logging/runtime-logger.js';

installRuntimeLogger({
  context: 'content',
  write: (entry) => new Promise((resolve) => {
    try {
      const result = chrome.runtime.sendMessage({ action: ActionTypes.APPEND_RUNTIME_LOG, payload: entry }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
      if (result != null && typeof result.then === 'function') result.catch(() => {});
    } catch {
      resolve();
    }
  })
});

// 顶层页面使用完整能力；iframe 由 frame-content-bundle.js 独立承载轻量能力。
const linkInterceptor = new LinkInterceptor();
linkInterceptor.init().catch((err) => {
  console.warn('[BetterBrowse] 内容脚本链接拦截器初始化失败:', err);
});

// 监听来自后台/扩展的指令（例如表单状态检查与倒计时弹窗）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  if (message.action === ActionTypes.CHECK_FORM_INPUT) {
    const result = FormDetector.detectActiveForm();
    sendResponse({
      success: true,
      data: result
    });
    return false;
  }

  if (message.action === ActionTypes.SHOW_AUTO_STASH_COUNTDOWN) {
    const { countdownSeconds, currentCount, threshold, nonce } = message.payload || {};
    CountdownBanner.show({ countdownSeconds, currentCount, threshold, nonce });
    sendResponse({ success: true });
    return false;
  }

  if (message.action === ActionTypes.HIDE_AUTO_STASH_COUNTDOWN) {
    CountdownBanner.hide();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === ActionTypes.NOTIFY_RULE_UPDATED || message.action === ActionTypes.NOTIFY_CONFIG_UPDATED) {
    const nextMode = message.payload?.effectiveMode;
    if (nextMode) {
      linkInterceptor.applyEffectiveMode(nextMode);
      linkInterceptor.scheduleSync();
    } else {
      linkInterceptor.refreshRulesCache().then(() => linkInterceptor.scheduleSync());
    }
    sendResponse({ success: true });
    return false;
  }

  return false;
});

