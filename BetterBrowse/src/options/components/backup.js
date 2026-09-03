/**
 * @file backup.js
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




export class BackupComponent {
  /**
   * @param {Function} onDataRestored - 恢复备份后通知全局刷新数据的回调
   */
  constructor(onDataRestored) {
    this.onDataRestored = onDataRestored;

    this.txtRestoreJSON = document.getElementById('restoreJSONTextarea');
    this.fileRestoreJSON = document.getElementById('fileRestoreJSON');
    this.btnRestoreFromText = document.getElementById('btnRestoreFromText');

    this.btnExportFullJSON = document.getElementById('btnExportFullJSON');
    this.btnCopyFullJSON = document.getElementById('btnCopyFullJSON');

    this.txtImportThirdParty = document.getElementById('importThirdPartyTextarea');
    this.btnImportThirdPartyText = document.getElementById('btnImportThirdPartyText');
    this.fileImportThirdParty = document.getElementById('fileImportThirdParty');

    this.btnCopyOneTabScript = document.getElementById('btnCopyOneTabScript');
    this.btnExportOneTabText = document.getElementById('btnExportOneTabText');
    this.btnCopyOneTabText = document.getElementById('btnCopyOneTabText');

    this.btnDeduplicate = document.getElementById('btnDeduplicateStash');
    this.btnClearAllStash = document.getElementById('btnClearAllStash');
    this.autoBackupList = document.getElementById('autoBackupList');

    this.init();
  }

  init() {
    this.bindEvents();
    this.loadAutoBackups();
  }

  bindEvents() {
    // 1. 导出完整 JSON 备份文件
    this.btnExportFullJSON?.addEventListener('click', async () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const filename = `better-browse-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
      try {
        if (typeof window.showSaveFilePicker === 'function') {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
          });
          const writable = await handle.createWritable();
          let cursor = null;
          let expectedStashRevision;
          do {
            const res = await MessageBus.sendToBackground(ActionTypes.READ_EXPORT_CHUNK, {
              type: 'full_backup',
              cursor,
              expectedStashRevision
            });
            if (!res.success || !res.data?.chunk) throw new Error(res.error || res.data?.error || '导出失败');
            await writable.write(res.data.chunk);
            cursor = res.data.nextCursor;
            expectedStashRevision = res.data.stashRevision;
          } while (cursor);
          await writable.close();
          Toast.show('完整备份文件已成功导出');
          return;
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.warn('[Backup] 流式导出失败，回退完整备份:', err);
      }
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_FULL_BACKUP);
      if (res.success && res.data) {
        const jsonStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        Toast.show('完整备份文件已成功导出');
      } else {
        Toast.show('导出失败');
      }
    });

    // 2. 复制完整 JSON 数据
    this.btnCopyFullJSON?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_FULL_BACKUP);
      if (res.success && res.data) {
        const jsonStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
        await navigator.clipboard.writeText(jsonStr);
        Toast.show('完整备份数据已复制到剪贴板');
      }
    });

    // 3. 从文本恢复 JSON 备份
    this.btnRestoreFromText?.addEventListener('click', async () => {
      const raw = this.txtRestoreJSON?.value.trim();
      if (!raw) {
        Toast.show('请先粘贴备份 JSON 数据');
        return;
      }
      try {
        const backupData = JSON.parse(raw);
        await this.executeRestoreJSON(backupData);
      } catch (err) {
        Toast.show(`JSON 格式解析错误：${err.message}`);
      }
    });

    // 4. 选择 JSON 文件恢复
    this.fileRestoreJSON?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const backupData = JSON.parse(event.target.result);
          await this.executeRestoreJSON(backupData);
        } catch (err) {
          Toast.show(`文件解析失败：${err.message}`);
        }
        this.fileRestoreJSON.value = '';
      };
      reader.readAsText(file);
    });

    // 5. 从第三方文本解析导入
    this.btnImportThirdPartyText?.addEventListener('click', async () => {
      const raw = this.txtImportThirdParty?.value.trim();
      if (!raw) {
        Toast.show('请先粘贴待导入的文本内容');
        return;
      }
      await this.executeImportThirdParty(raw);
    });

    // 6. 选择第三方文件导入
    this.fileImportThirdParty?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target.result;
        if (typeof content === 'string') {
          await this.executeImportThirdParty(content);
        }
        this.fileImportThirdParty.value = '';
      };
      reader.readAsText(file);
    });

    // 7. 一键复制 OneTab 提取脚本
    this.btnCopyOneTabScript?.addEventListener('click', async () => {
      await navigator.clipboard.writeText('copy(localStorage.state)');
      Toast.show('已复制提取命令：copy(localStorage.state)！请至 OneTab 页面 F12 控制台粘贴执行');
    });

    // 8. 导出 OneTab 纯文本文件
    this.btnExportOneTabText?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_ONETAB_TEXT);
      if (res.success && typeof res.data === 'string') {
        const blob = new Blob([res.data], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `onetab-export-${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        Toast.show('OneTab 格式纯文本已成功导出');
      } else {
        Toast.show(`导出失败：${res?.error || '后台服务异常，请稍后重试'}`);
      }
    });

    // 9. 复制 OneTab 格式纯文本
    this.btnCopyOneTabText?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_ONETAB_TEXT);
      if (res.success && typeof res.data === 'string') {
        await navigator.clipboard.writeText(res.data);
        Toast.show('OneTab 格式文本已复制到剪贴板');
      } else {
        Toast.show(`导出失败：${res?.error || '后台服务异常，请稍后重试'}`);
      }
    });

    // 10. 智能去重
    this.btnDeduplicate?.addEventListener('click', async () => {
      this.btnDeduplicate.disabled = true;
      Toast.show('正在智能比对指纹并去重...');
      const res = await MessageBus.sendToBackground(ActionTypes.DEDUPLICATE_STASH_DATA);
      if (res.success && res.data) {
        const { removedCount, groupCountAfter } = res.data;
        if (removedCount > 0) {
          Toast.show(`去重完成！清理了 ${removedCount} 个重复标签组（剩余 ${groupCountAfter} 组）`);
          this.onDataRestored?.();
        } else {
          Toast.show('收纳箱中没有发现重复的标签组');
        }
      } else {
        Toast.show(res.error || '去重失败');
      }
      this.btnDeduplicate.disabled = false;
    });

    // 11. 危险清空
    this.btnClearAllStash?.addEventListener('click', async () => {
      if (confirm('警告：此操作将清空收纳箱所有历史数据（锁定组除外）且无法撤销！\n\n确定要继续吗？')) {
        const res = await MessageBus.sendToBackground(ActionTypes.CLEAR_ALL_STASH);
        if (res.success) {
          Toast.show('已清空收纳箱非锁定数据');
          this.onDataRestored?.();
        }
      }
    });
  }

  async loadAutoBackups() {
    if (!this.autoBackupList) return;
    const res = await MessageBus.sendToBackground(ActionTypes.LIST_AUTO_BACKUPS);
    const items = Array.isArray(res?.data) ? res.data : [];
    this.autoBackupList.innerHTML = '';
    if (!res?.success || items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sync-empty';
      empty.id = 'autoBackupEmpty';
      empty.textContent = '暂无自动快照（可在收纳箱设置中开启每日快照）';
      this.autoBackupList.appendChild(empty);
      return;
    }
    for (const backup of items) {
      const createdAt = Number(backup.createdAt) || 0;
      const row = document.createElement('div');
      row.className = 'conflict-item';

      const head = document.createElement('div');
      head.className = 'conflict-head';
      head.textContent = createdAt ? new Date(createdAt).toLocaleString('zh-CN') : '未知时间';

      const meta = document.createElement('div');
      meta.className = 'device-meta';
      meta.textContent = `${backup.groupCount ?? 0} 组 · ${backup.entryCount ?? 0} 条`;

      const actions = document.createElement('div');
      actions.className = 'btn-group';
      const btnRestore = document.createElement('button');
      btnRestore.className = 'btn btn-secondary btn-sm';
      btnRestore.type = 'button';
      btnRestore.textContent = '恢复';
      btnRestore.addEventListener('click', () => this.restoreAutoBackup(createdAt));
      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn btn-danger btn-sm';
      btnDelete.type = 'button';
      btnDelete.textContent = '删除';
      btnDelete.addEventListener('click', () => this.deleteAutoBackup(createdAt));
      actions.append(btnRestore, btnDelete);
      row.append(head, meta, actions);
      this.autoBackupList.appendChild(row);
    }
  }

  async restoreAutoBackup(createdAt) {
    if (!window.confirm('将把该快照中的收纳组写回，不删除现有其他组。确定恢复？')) return;
    const res = await MessageBus.sendToBackground(ActionTypes.RESTORE_AUTO_BACKUP, {
      createdAt,
      confirm: true
    });
    const data = res?.data || {};
    const ok = res?.success && data.success !== false;
    Toast.show(ok ? `已恢复 ${data.groupCount ?? ''} 个收纳组`.trim() : (data.error || res?.error || '恢复失败'));
    if (ok) this.onDataRestored?.();
    await this.loadAutoBackups();
  }

  async deleteAutoBackup(createdAt) {
    if (!window.confirm('确定删除该自动快照？此操作不可撤销。')) return;
    const res = await MessageBus.sendToBackground(ActionTypes.DELETE_AUTO_BACKUP, {
      createdAt,
      confirm: true
    });
    const data = res?.data || {};
    Toast.show(res?.success && data.success !== false ? '已删除该快照' : (data.error || res?.error || '删除失败'));
    await this.loadAutoBackups();
  }

  async executeRestoreJSON(backupData) {
    if (!backupData || typeof backupData !== 'object') {
      Toast.show('备份数据无效');
      return;
    }
    const res = await MessageBus.sendToBackground(ActionTypes.RESTORE_FULL_BACKUP, {
      jsonString: JSON.stringify(backupData)
    });
    if (res.success) {
      Toast.show('全量数据恢复成功！配置与收纳箱已同步更新');
      if (this.txtRestoreJSON) this.txtRestoreJSON.value = '';
      this.onDataRestored?.();
    } else {
      Toast.show(res.error || '恢复失败');
    }
  }

  async executeImportThirdParty(rawText) {
    Toast.show('正在智能解析第三方数据...');
    const res = await MessageBus.sendToBackground(ActionTypes.IMPORT_THIRD_PARTY_DATA, { textString: rawText });
    if (res.success && res.data) {
      const { importedCount, groupCount, formatName } = res.data;
      Toast.show(`成功识别 [${formatName || '数据'}]：已导入 ${groupCount} 个标签组（共 ${importedCount} 个网页）`);
      if (this.txtImportThirdParty) this.txtImportThirdParty.value = '';
      this.onDataRestored?.();
    } else {
      Toast.show(res.error || '未能从输入中提取有效网页链接');
    }
  }
}

/**
 * 云端同步 (WebDAV) 组件：凭据、连接探测、状态、冲突裁决与设备管理
 */
