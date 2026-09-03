/**
 * @file toast.js
 * @description 选项页组件模块
 * @encoding UTF-8
 */


import { ActionTypes } from '../../constants/action-types.js';
import { StorageKeys } from '../../constants/storage-keys.js';
import { LinkModes, LOCAL_DATA_SCHEMA_REVISION } from '../../constants/config.js';
import { API_VERSION } from '../../constants/api-version.js';
import { LinkMatcher } from '../../core/link/link-matcher.js';
import { MessageBus } from '../../core/bus/message-bus.js';
import { installRuntimeLogger } from '../../core/logging/runtime-logger.js';
import {
  GROUP_OVERSCAN,
  TAB_OVERSCAN,
  TABS_INITIAL_LIMIT,
  computePads,
  estimateGroupCardHeight,
  getDensityMetrics,
  getItemWindow,
  getVisibleRange
} from '../list-window.js';




export class Toast {
  static show(message, duration = 3200, action = null) {
    const el = document.getElementById('toastNotification');
    if (!el) return;

    el.innerHTML = '';
    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    el.appendChild(textSpan);

    if (action && action.text && typeof action.onClick === 'function') {
      const actionBtn = document.createElement('button');
      actionBtn.className = 'toast-action-btn';
      actionBtn.textContent = action.text;
      actionBtn.type = 'button';
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        el.classList.add('hidden');
        action.onClick();
      });
      el.appendChild(actionBtn);
    }

    el.classList.remove('hidden');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      el.classList.add('hidden');
    }, duration);
  }
}

/**
 * 现代扁平化自定义下拉菜单增强器 (CustomSelectEnhancer)
 * - 零侵入替换原生简陋直角 select 弹层为现代扁平卡片浮层
 * - 支持深浅色自适应、Checkmark 勾选标识、微动画过渡、上下键导航与无障碍
 * - 双向同步底层原生 select 的 value 与 change 事件
 */
