/**
 * @file index.js
 * @description 内容脚本总入口（初始化链接拦截器与表单状态监听）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { LinkInterceptor } from './link-interceptor.js';
import { FormDetector } from './form-detector.js';
import { CountdownBanner } from './countdown-banner.js';

// 是否处于 iframe 中：iframe 内启用轻量模式（仅点击拦截与主世界桥接），
// 跳过 DOM 全量扫描 / 悬浮预处理 / 倒计时卡片，避免广告等海量 iframe 拖累页面性能
const IS_IN_IFRAME = window.top !== window.self;

// 初始化并启动链接拦截器
const linkInterceptor = new LinkInterceptor();
linkInterceptor.init({ lightweight: IS_IN_IFRAME }).catch((err) => {
  console.warn('[BetterBrowse] 内容脚本链接拦截器初始化失败:', err);
});

// 监听来自后台/扩展的指令（例如表单状态检查与倒计时弹窗）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  // 表单检测在 iframe 内同样有意义（用户可能在 iframe 表单中输入）
  if (message.action === ActionTypes.CHECK_FORM_INPUT) {
    const result = FormDetector.detectActiveForm();
    sendResponse({
      success: true,
      data: result
    });
    return false;
  }

  // 倒计时卡片仅在顶层框架展示
  if (!IS_IN_IFRAME && message.action === ActionTypes.SHOW_AUTO_STASH_COUNTDOWN) {
    const { countdownSeconds, currentCount, threshold } = message.payload || {};
    CountdownBanner.show({ countdownSeconds, currentCount, threshold });
    sendResponse({ success: true });
    return false;
  }

  if (!IS_IN_IFRAME && message.action === ActionTypes.HIDE_AUTO_STASH_COUNTDOWN) {
    CountdownBanner.hide();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === ActionTypes.NOTIFY_RULE_UPDATED || message.action === ActionTypes.NOTIFY_CONFIG_UPDATED) {
    linkInterceptor.refreshRulesCache().then(() => {
      linkInterceptor.scheduleSync();
    });
    sendResponse({ success: true });
    return false;
  }

  return false;
});

