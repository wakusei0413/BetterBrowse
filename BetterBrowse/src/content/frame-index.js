/**
 * @file frame-index.js
 * @description iframe 轻量内容脚本入口，仅保留点击拦截、模式同步与表单检测
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { LinkInterceptor } from './link-interceptor.js';
import { FormDetector } from './form-detector.js';

if (window.top !== window.self) {
  const linkInterceptor = new LinkInterceptor();
  linkInterceptor.init({ lightweight: true }).catch((err) => {
    console.warn('[BetterBrowse] iframe 轻量拦截器初始化失败:', err);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.action) return false;

    if (message.action === ActionTypes.CHECK_FORM_INPUT) {
      sendResponse({ success: true, data: FormDetector.detectActiveForm() });
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
}
