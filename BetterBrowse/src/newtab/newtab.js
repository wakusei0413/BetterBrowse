/**
 * @file newtab.js
 * @description 独立新标签页入口脚本（纯轻量，不加载 OptionsApp / 侧栏）
 * @encoding UTF-8
 */

import { HomeView } from '../home/home-view.js';
import { ActionTypes } from '../constants/action-types.js';
import { MessageBus } from '../core/bus/message-bus.js';
import { installRuntimeLogger } from '../core/logging/runtime-logger.js';

installRuntimeLogger({
  context: 'newtab',
  write: (entry) => MessageBus.sendToBackground(ActionTypes.APPEND_RUNTIME_LOG, entry)
});

document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('newtabApp');
  if (!container) return;

  const homeView = new HomeView({
    container,
    openTarget: 'current', // 独立新标签页在当前页打开
    isStandalone: true
  });

  window.addEventListener('focus', () => {
    homeView.activate();
  });

  window.addEventListener('beforeunload', () => {
    homeView.destroy();
  });
});
