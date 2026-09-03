/**
 * @file ai-bridge.js
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
import { Toast } from './toast.js';




export class AIBridgeComponent {
  constructor() {
    this.$enabled = document.getElementById('chkAiBridgeEnabled');
    this.$statusDot = document.getElementById('aiBridgeStatusDot');
    this.$statusBadge = document.getElementById('aiBridgeStatusBadge');
    this.$statusMessage = document.getElementById('aiBridgeStatusMessage');
    this.$extensionId = document.getElementById('aiBridgeExtensionId');
    this.$proto = document.getElementById('aiBridgeApiVersion');
    this.$btnCopyId = document.getElementById('btnAiBridgeCopyId');
    this.$btnRefresh = document.getElementById('btnAiBridgeRefresh');
    this.init();
  }

  init() {
    this.$enabled?.addEventListener('change', () => this.saveEnabled());
    this.$btnCopyId?.addEventListener('click', () => this.copyExtensionId());
    this.$btnRefresh?.addEventListener('click', () => this.loadAll());
    this.loadAll();
  }

  async loadAll() {
    await Promise.all([this.loadConfig(), this.loadStatus()]);
  }

  async loadConfig() {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_CONFIG);
    if (this.$enabled && res?.success && res.data) {
      this.$enabled.checked = res.data.aiBridge?.enabled === true;
    }
  }

  async loadStatus() {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_AI_BRIDGE_STATUS);
    if (!res?.success || !res.data) return;
    const status = res.data;

    const stateLabelMap = {
      disabled: '未启用',
      connecting: '暂无连接',
      connected: 'AI Agent 已连接',
      incompatible: 'API 版本不兼容',
      reconnecting: 'AI Agent 连接中断，重连中…',
      host_missing: '暂无 AI Agent 连接',
      error: '连接异常',
      unsupported: '当前环境不支持'
    };
    const dotStatusMap = {
      connected: 'synced',
      connecting: 'pending',
      incompatible: 'auth_failed',
      reconnecting: 'pending',
      host_missing: 'auth_failed',
      error: 'auth_failed',
      unsupported: 'auth_failed',
      disabled: 'idle'
    };
    if (this.$statusBadge) this.$statusBadge.textContent = stateLabelMap[status.state] || '未启用';
    if (this.$statusDot) this.$statusDot.dataset.status = dotStatusMap[status.state] || 'idle';
    if (this.$statusMessage) {
      this.$statusMessage.textContent = status.state === 'host_missing'
        ? '请先执行 deno task ai-host-install 安装本机 AI Agent（扩展 ID 见下方）'
        : (status.lastError || '');
    }
    if (this.$extensionId) this.$extensionId.textContent = status.extensionId || chrome.runtime.id || '-';
    if (this.$proto) this.$proto.textContent = String(status.apiVersion ?? '-');
  }

  async saveEnabled() {
    const enabled = this.$enabled?.checked === true;
    const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
      aiBridge: { enabled }
    });
    Toast.show(res?.success
      ? (enabled ? 'AI 桥接已开启，本机 AI Agent 将按需连接' : 'AI 桥接已关闭，本机通道已断开')
      : (res?.error || '保存失败'));
    await this.loadStatus();
  }

  async copyExtensionId() {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_AI_BRIDGE_STATUS);
    const extensionId = res?.data?.extensionId || chrome.runtime.id || '';
    if (!extensionId) {
      Toast.show('无法获取扩展 ID');
      return;
    }
    try {
      await navigator.clipboard.writeText(extensionId);
      Toast.show('扩展 ID 已复制，安装 AI Agent 时使用 --ext-id 参数传入');
    } catch {
      Toast.show('复制失败，请手动选择并复制');
    }
  }
}
