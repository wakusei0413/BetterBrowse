/**
 * @file index.js
 * @description 内容脚本总入口（初始化链接拦截器与表单状态监听）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { LinkInterceptor } from './link-interceptor.js';
import { FormDetector } from './form-detector.js';
import { CountdownBanner } from './countdown-banner.js';

// 初始化并启动链接拦截器
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
    const { countdownSeconds, currentCount, threshold } = message.payload || {};
    CountdownBanner.show({ countdownSeconds, currentCount, threshold });
    sendResponse({ success: true });
    return false;
  }

  if (message.action === ActionTypes.HIDE_AUTO_STASH_COUNTDOWN) {
    CountdownBanner.hide();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === ActionTypes.NOTIFY_RULE_UPDATED || message.action === ActionTypes.NOTIFY_CONFIG_UPDATED) {
    linkInterceptor.refreshRulesCache().then(() => {
      linkInterceptor.syncModeToMainWorld();
      linkInterceptor.syncAllPageLinks();
    });
    sendResponse({ success: true });
    return false;
  }

  return false;
});

