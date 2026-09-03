/**
 * @file webdav-sync.js
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




export class WebdavSyncComponent {
  constructor() {
    this.$serverUrl = document.getElementById('webdavServerUrl');
    this.$username = document.getElementById('webdavUsername');
    this.$password = document.getElementById('webdavPassword');
    this.$enabled = document.getElementById('chkWebdavEnabled');
    this.$autoSync = document.getElementById('chkWebdavAutoSync');
    this.$accountConfigSync = document.getElementById('chkAccountConfigSync');
    this.$btnSave = document.getElementById('btnWebdavSave');
    this.$btnTest = document.getElementById('btnWebdavTest');
    this.$btnSyncNow = document.getElementById('btnSyncNow');
    this.$statusDot = document.getElementById('syncStatusDot');
    this.$statusBadge = document.getElementById('syncStatusBadge');
    this.$statusMessage = document.getElementById('syncStatusMessage');
    this.$deviceId = document.getElementById('syncDeviceId');
    this.$pendingCount = document.getElementById('syncPendingCount');
    this.$conflictCount = document.getElementById('syncConflictCount');
    this.$lastAt = document.getElementById('syncLastAt');
    this.$conflictsList = document.getElementById('syncConflictsList');
    this.$devicesList = document.getElementById('syncDevicesList');
    this.$recoveryMessage = document.getElementById('syncRecoveryMessage');
    this.$btnFallbackSnapshot = document.getElementById('btnSyncFallbackSnapshot');
    this.$btnRebuildFromScratch = document.getElementById('btnSyncRebuildFromScratch');
    this.init();
  }

  init() {
    this.$btnSave?.addEventListener('click', () => this.saveCredentials());
    this.$btnTest?.addEventListener('click', () => this.testConnection());
    this.$btnSyncNow?.addEventListener('click', () => this.syncNow());
    this.$enabled?.addEventListener('change', () => this.saveCredentials());
    this.$autoSync?.addEventListener('change', () => this.saveCredentials());
    this.$accountConfigSync?.addEventListener('change', () => this.saveAccountConfigSync());
    this.$btnFallbackSnapshot?.addEventListener('click', () => this.fallbackPreviousSnapshot());
    this.$btnRebuildFromScratch?.addEventListener('click', () => this.rebuildFromScratch());
    this.loadAll();
  }

  async loadAll() {
    await Promise.all([
      this.loadStatus(),
      this.loadConflicts(),
      this.loadDevices()
    ]);
  }

  async loadStatus() {
    await this.loadAccountConfigSync();
    const res = await MessageBus.sendToBackground(ActionTypes.GET_SYNC_STATUS);
    const status = res?.success && res.data ? res.data : {};
    if (!res?.success || !res.data) {
      await this.loadRecoveryInfo(status);
      return;
    }
    if (this.$serverUrl && !this.$serverUrl.value) this.$serverUrl.value = status.serverUrl || '';
    if (this.$username && !this.$username.value) this.$username.value = status.username || '';
    if (this.$enabled) this.$enabled.checked = status.enabled === true;
    if (this.$autoSync) this.$autoSync.checked = status.autoSync !== false;
    if (this.$deviceId) this.$deviceId.textContent = status.deviceId || '-';
    if (this.$pendingCount) this.$pendingCount.textContent = String(status.pendingCount ?? 0);
    if (this.$conflictCount) this.$conflictCount.textContent = String(status.conflictCount ?? 0);
    if (this.$lastAt) {
      this.$lastAt.textContent = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('zh-CN') : '-';
    }
    const labelMap = {
      synced: '已同步',
      pending: '离线待上传',
      auth_failed: '认证失败',
      capability_missing: '服务器能力不足',
      conflict: '条件写入冲突',
      corrupt: '数据损坏',
      unknown: '未知错误',
      idle: '尚未同步'
    };
    if (this.$statusBadge) this.$statusBadge.textContent = labelMap[status.status] || '尚未同步';
    if (this.$statusDot) this.$statusDot.dataset.status = status.status || 'idle';
    if (this.$statusMessage) this.$statusMessage.textContent = status.message || '';
    await this.loadRecoveryInfo(status);
  }

  async loadAccountConfigSync() {
    const configRes = await MessageBus.sendToBackground(ActionTypes.GET_CONFIG);
    if (!this.$accountConfigSync || !configRes?.success || !configRes.data) return;
    this.$accountConfigSync.checked = configRes.data.accountConfigSync?.enabled !== false;
  }

  async saveAccountConfigSync() {
    const enabled = this.$accountConfigSync?.checked !== false;
    const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
      accountConfigSync: { enabled }
    });
    Toast.show(res?.success ? (enabled ? '已开启浏览器账号偏好同步' : '已关闭浏览器账号偏好同步') : (res?.error || '保存失败'));
  }

  async saveCredentials() {
    const payload = {
      serverUrl: this.$serverUrl?.value.trim() || '',
      username: this.$username?.value.trim() || '',
      enabled: this.$enabled?.checked === true,
      autoSync: this.$autoSync?.checked !== false
    };
    const password = this.$password?.value || '';
    if (password) payload.password = password;
    const res = await MessageBus.sendToBackground(ActionTypes.SAVE_WEBDAV_CREDENTIALS, payload);
    if (!res?.success) {
      Toast.show(res?.error || '保存失败');
      return;
    }
    this.$password.value = '';
    Toast.show('WebDAV 凭据已保存到本机');
    await this.loadStatus();
  }

  async testConnection() {
    Toast.show('正在探测服务器 ETag 条件写入能力…');
    const res = await MessageBus.sendToBackground(ActionTypes.TEST_WEBDAV_CONNECTION);
    // 消息总线会把处理器返回值包装为 { success, data }，真实结果在 data 内
    const data = res?.data || {};
    if (res?.success && data.success !== false) {
      Toast.show(data.message || '连接与条件写入探测通过');
    } else {
      Toast.show(data.error || res?.error || '连接失败');
    }
    await this.loadStatus();
  }

  async syncNow() {
    Toast.show('正在同步…');
    const res = await MessageBus.sendToBackground(ActionTypes.RUN_SYNC_NOW);
    // 消息总线会把处理器返回值包装为 { success, data }，真实结果在 data 内
    const data = res?.data || {};
    if (res?.success && data.success !== false) {
      Toast.show(data.pendingCount > 0
        ? `同步完成（待上传 ${data.pendingCount} 条）`
        : '同步完成，云端已是最新');
    } else {
      Toast.show(data.error || res?.error || '同步失败');
    }
    await this.loadAll();
  }

  async loadConflicts() {
    const res = await MessageBus.sendToBackground(ActionTypes.LIST_SYNC_CONFLICTS);
    const conflicts = res?.success && Array.isArray(res.data) ? res.data : [];
    if (!this.$conflictsList) return;
    if (conflicts.length === 0) {
      this.$conflictsList.innerHTML = '<p class="sync-empty">当前没有待裁决的冲突 🎉</p>';
      return;
    }
    this.$conflictsList.innerHTML = '';
    for (const conflict of conflicts) {
      const item = document.createElement('div');
      item.className = 'conflict-item';
      const head = document.createElement('div');
      head.className = 'conflict-head';
      head.textContent = `${conflict.entityType} · ${conflict.field}`;
      const values = document.createElement('div');
      values.className = 'conflict-values';
      const local = document.createElement('code');
      local.textContent = `本机：${this._preview(conflict.localValue)}`;
      const incoming = document.createElement('code');
      incoming.textContent = `云端：${this._preview(conflict.incomingValue)}`;
      values.append(local, incoming);
      const actions = document.createElement('div');
      actions.className = 'btn-group';
      const keepLocal = document.createElement('button');
      keepLocal.className = 'btn btn-secondary btn-sm';
      keepLocal.type = 'button';
      keepLocal.textContent = '保留本机值';
      keepLocal.addEventListener('click', () => this.resolveConflict(conflict.conflictId, 'local'));
      const useCloud = document.createElement('button');
      useCloud.className = 'btn btn-primary btn-sm';
      useCloud.type = 'button';
      useCloud.textContent = '采用云端值';
      useCloud.addEventListener('click', () => this.resolveConflict(conflict.conflictId, 'incoming'));
      actions.append(keepLocal, useCloud);
      item.append(head, values, actions);
      this.$conflictsList.appendChild(item);
    }
  }

  _preview(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const plain = String(text ?? '');
    return plain.length > 60 ? `${plain.slice(0, 60)}…` : plain;
  }

  async resolveConflict(conflictId, choice) {
    const res = await MessageBus.sendToBackground(ActionTypes.RESOLVE_SYNC_CONFLICT, { conflictId, choice });
    const data = res?.data || {};
    Toast.show(res?.success && data.success !== false ? '已裁决并写入同步队列' : (data.error || res?.error || '裁决失败'));
    await this.loadAll();
  }

  async loadDevices() {
    const res = await MessageBus.sendToBackground(ActionTypes.LIST_SYNC_DEVICES);
    const devices = res?.success && Array.isArray(res.data) ? res.data : [];
    if (!this.$devicesList) return;
    if (devices.length === 0) {
      this.$devicesList.innerHTML = '<p class="sync-empty">尚未获取设备列表（首次同步后出现）</p>';
      return;
    }
    this.$devicesList.innerHTML = '';
    for (const device of devices) {
      const item = document.createElement('div');
      item.className = 'device-item';
      const info = document.createElement('div');
      info.className = 'device-info';
      const name = document.createElement('span');
      name.textContent = `${device.isSelf ? '本机' : '设备'} · ${String(device.deviceId).slice(0, 18)}…`;
      const meta = document.createElement('span');
      meta.className = 'device-meta';
      meta.textContent = [
        device.retired ? '已退役' : '活跃',
        device.lastSeenAt ? `最近同步 ${new Date(device.lastSeenAt).toLocaleString('zh-CN')}` : ''
      ].filter(Boolean).join(' · ');
      info.append(name, meta);
      const actions = document.createElement('div');
      actions.className = 'btn-group';
      if (!device.retired && !device.isSelf) {
        const retireBtn = document.createElement('button');
        retireBtn.className = 'btn btn-danger btn-sm';
        retireBtn.type = 'button';
        retireBtn.textContent = '退役';
        retireBtn.addEventListener('click', () => this.retireDevice(device.deviceId));
        actions.appendChild(retireBtn);
      }
      item.append(info, actions);
      this.$devicesList.appendChild(item);
    }
  }

  async retireDevice(deviceId) {
    if (!window.confirm('确定将该设备退役吗？退役设备回归时将从最新快照重新配对。')) return;
    const res = await MessageBus.sendToBackground(ActionTypes.RETIRE_SYNC_DEVICE, { deviceId });
    const data = res?.data || {};
    Toast.show(res?.success && data.success !== false ? '设备已退役' : (data.error || res?.error || '操作失败'));
    await this.loadDevices();
  }

  async loadRecoveryInfo(statusHint) {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_SYNC_RECOVERY_INFO);
    const info = res?.success && res.data && typeof res.data === 'object' ? res.data : {};
    const status = statusHint?.status || info.status || '';
    const isCorrupt = status === 'corrupt' || info.corrupt === true;
    const hasLocalSnapshot = info.hasLocalSnapshot === true;
    const enableActions = isCorrupt || hasLocalSnapshot;

    if (this.$recoveryMessage) {
      if (isCorrupt) {
        this.$recoveryMessage.textContent = info.message || statusHint?.message || '远端数据损坏，可回退上一份快照或从本机快照重建。';
      } else if (hasLocalSnapshot) {
        this.$recoveryMessage.textContent = '当前同步正常。本机有可用快照，损坏时可用于重建。';
      } else {
        this.$recoveryMessage.textContent = '当前同步正常。损坏时将在此启用恢复操作。';
      }
    }
    if (this.$btnFallbackSnapshot) this.$btnFallbackSnapshot.disabled = !enableActions;
    if (this.$btnRebuildFromScratch) this.$btnRebuildFromScratch.disabled = !enableActions;
  }

  async fallbackPreviousSnapshot() {
    const res = await MessageBus.sendToBackground(ActionTypes.FALLBACK_PREVIOUS_SNAPSHOT);
    const data = res?.data || {};
    Toast.show(res?.success && data.success !== false ? (data.message || '已回退上一份快照') : (data.error || res?.error || '回退失败'));
    await this.loadAll();
  }

  async rebuildFromScratch() {
    if (!window.confirm('危险：将用本机快照从头重建云端同步状态，可能覆盖远端损坏数据。确定继续？')) return;
    const res = await MessageBus.sendToBackground(ActionTypes.REBUILD_SYNC_FROM_SCRATCH, { confirm: true });
    const data = res?.data || {};
    Toast.show(res?.success && data.success !== false ? (data.message || '已从本机快照重建') : (data.error || res?.error || '重建失败'));
    await this.loadAll();
  }
}

/**
 * AI 桥接组件 (AIBridgeComponent)
 * 桥接开关 / 连接状态 / 扩展 ID 复制（操作审计统一在运行日志页查看）
 */
