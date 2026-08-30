/**
 * @file local-stash-repo.js
 * @description 本地标签页收纳仓储门面（IndexedDB 主库优先，chrome.storage.local 旧存储兜底；支持分组、星标、锁定、重命名、搜索与 OneTab 无缝双向互导）
 * @encoding UTF-8
 */

import { StorageKeys } from '../../constants/storage-keys.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { OneTabConverter } from './onetab-converter.js';
import { DefaultConfig } from '../../constants/config.js';
import { IndexedDBManager } from '../storage/indexed-db.js';
import { IndexedStashRepository } from './indexed-stash-repo.js';

export class LocalStashRepository {
  // ============================================================
  // 存储门面：IndexedDB 主库优先，chrome.storage.local 旧存储兜底
  // ============================================================

  /**
   * 解析当前生效的存储后端
   *
   * 版本门控说明：仅当 v5 迁移完成（schema 版本 ≥ 5）后 IndexedDB 才是权威数据源。
   * 版本切换在迁移的跨上下文写锁内原子完成，因此：
   * - 迁移进行中（版本仍为 4）：读写全部走旧存储，迁移期间的并发写入不会漏拷；
   * - 迁移完成后（版本 5）：读写全部走 IndexedDB；
   * - 显式回退（bb_idb_optout）：固定使用旧存储。
   *
   * ⚠️ 写方法的后端决策必须发生在写锁临界区内（见各写方法实现），
   * 否则"决策走旧存储 → 迁移完成切版本 → 写入旧存储"的竞态会导致数据漏写。
   * @returns {Promise<IndexedStashRepository | null>}
   */
  static async _getBackend() {
    if (!IndexedStashRepository.isSupported()) return null;
    try {
      if ((await StorageAdapter.get(StorageKeys.IDB_OPTOUT, false)) === true) return null;
      const version = Number(await StorageAdapter.get(StorageKeys.SCHEMA_VERSION, 0)) || 0;
      return version >= 5 ? IndexedStashRepository : null;
    } catch {
      return null;
    }
  }

  /**
   * 广播收纳数据变更
   * IndexedDB 模式下 chrome.storage.onChanged 不再感知收纳变化，
   * 通过修订号（bb_stash_revision）通知各上下文（选项页监听此键实现 0 刷新即时呈现）。
   */
  static async _notifyStashChanged() {
    try {
      await StorageAdapter.set(
        StorageKeys.STASH_REV,
        `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      );
    } catch {
      // 通知失败不影响主流程
    }
  }

  /**
   * 构建轻量级备份快照，剔除体积大户 favIconUrl 并截断标题
   * @param {any[]} groups - 当前收纳组列表
   * @param {boolean} [stripFavIcons=true]
   * @returns {any[]}
   */
  static createBackupSnapshot(groups, stripFavIcons = true) {
    return groups.map((group) => ({
      id: group.id,
      createdAt: group.createdAt,
      title: typeof group.title === 'string' ? group.title.slice(0, 200) : '',
      locked: Boolean(group.locked),
      starred: Boolean(group.starred),
      archived: Boolean(group.archived),
      tabs: (group.tabs || []).map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: typeof tab.title === 'string' ? tab.title.slice(0, 4096) : tab.url || '',
        pinned: Boolean(tab.pinned),
        ...(stripFavIcons ? {} : { favIconUrl: tab.favIconUrl })
      }))
    }));
  }

  /**
   * 估算备份列表序列化后的大致字节数
   * @param {any[]} backups
   * @returns {number}
   */
  static estimateBackupBytes(backups) {
    try {
      return new Blob([JSON.stringify(backups)]).size;
    } catch {
      return Infinity;
    }
  }

  /**
   * 在配额限制内安全持久化自动备份
   * @param {any[]} backups
   * @returns {Promise<boolean>}
   */
  static async persistAutoBackups(backups) {
    const limits = DefaultConfig.autoBackupLimits || {};
    const maxTotalBytes = typeof limits.maxTotalBytes === 'number' ? limits.maxTotalBytes : 3 * 1024 * 1024;
    const maxBackups = typeof limits.maxBackups === 'number' ? limits.maxBackups : 2;

    let trimmed = backups.slice(0, maxBackups);

    // 若超出软上限，逐级丢弃最旧的快照，直至满足配额或只剩最新一份
    while (trimmed.length > 1 && this.estimateBackupBytes(trimmed) > maxTotalBytes) {
      trimmed.pop();
    }

    // 只剩一份仍超限，说明主数据本身已接近配额，跳过本次备份，避免污染主写入
    if (this.estimateBackupBytes(trimmed) > maxTotalBytes) {
      console.warn('[LocalStashRepository] 自动备份大小超出安全配额，已跳过本次快照');
      return false;
    }

    const ok = await StorageAdapter.set(StorageKeys.AUTO_BACKUPS, trimmed);
    if (!ok) {
      console.warn('[LocalStashRepository] 自动备份写入失败，可能由于存储配额不足');
    }
    return ok;
  }

  /**
   * 执行自动备份（收纳组创建成功后调用）
   * v7 起备份写入 IndexedDB settings 仓储（StorageAdapter 按版本门控路由），失败不影响主收纳。
   * @param {number} [now=Date.now()] - 备份快照时间戳
   */
  static async _runAutoBackupIfEnabled(now = Date.now()) {
    try {
      const config = await StorageAdapter.getUserConfig();
      const settings = config.stashSettings || {};
      if (settings.autoBackupEnabled === false) return;

      const currentGroups = await this.getAllGroups();
      const retentionDays = Math.max(1, Number(settings.backupRetentionDays) || 30);
      const cutoff = Date.now() - retentionDays * 86400000;
      const limits = DefaultConfig.autoBackupLimits || {};
      const stripFavIcons = limits.stripFavIcons !== false;

      const backups = await StorageAdapter.get(StorageKeys.AUTO_BACKUPS, []);
      const nextBackups = [
        { createdAt: now, groups: this.createBackupSnapshot(currentGroups, stripFavIcons) },
        ...(Array.isArray(backups)
          ? backups
              .filter((backup) => backup?.createdAt > cutoff)
              .map((backup) => ({
                createdAt: backup.createdAt,
                groups: this.createBackupSnapshot(backup.groups || [], stripFavIcons)
              }))
          : [])
      ];

      await this.persistAutoBackups(nextBackups);
    } catch (backupErr) {
      // 自动备份失败绝不影响主收纳流程
      console.warn('[LocalStashRepository] 自动备份异常，已忽略:', backupErr);
    }
  }

  /**
   * 获取所有已保存的收纳标签组列表（默认按时间倒序）
   * @returns {Promise<Array<{ id: string, createdAt: number, title: string, locked?: boolean, starred?: boolean, tabs: Array<{ id: string, url: string, title: string, favIconUrl?: string, pinned?: boolean }> }>>}
   */
  static async getAllGroups() {
    const backend = await this._getBackend();
    if (backend) {
      try {
        return await backend.getAllGroups();
      } catch (err) {
        // 读路径降级：IndexedDB 异常时回退旧存储快照（30 天保留期内仍可读，主库数据不受影响）
        console.warn('[LocalStashRepository] IndexedDB 读取失败，降级至 chrome.storage.local:', err);
      }
    }
    return await this._legacyGetAllGroups();
  }

  /**
   * 旧存储实现：整读 chrome.storage.local 数组并排序
   */
  static async _legacyGetAllGroups() {
    const groups = await StorageAdapter.get(StorageKeys.STASH_GROUPS, []);
    if (!Array.isArray(groups)) return [];
    return [...groups].sort((a, b) => {
      // 星标组优先置顶，其余按时间倒序
      if (a.starred && !b.starred) return -1;
      if (!a.starred && b.starred) return 1;
      return b.createdAt - a.createdAt;
    });
  }

  /**
   * 保存一组待收纳的标签页
   * @param {Array<{ url: string, title: string, favIconUrl?: string, pinned?: boolean }>} tabItems - 待收纳的标签数据
   * @param {string} [customTitle=''] - 自定义组标题
   * @returns {Promise<{ success: boolean, group?: Object }>}
   */
  static async createGroup(tabItems, customTitle = '') {
    if (!tabItems || tabItems.length === 0) {
      return { success: false };
    }

    // 写锁临界区内完成后端决策与写入，杜绝"决策后版本翻转"竞态
    return await IndexedDBManager.withWriteLock(async () => {
      const backend = await this._getBackend();
      if (backend) {
        try {
          const config = await StorageAdapter.getUserConfig();
          const result = await backend.createGroup(tabItems, customTitle, config.stashSettings || {});
          if (result?.success) {
            await this._runAutoBackupIfEnabled(Date.now());
            await this._notifyStashChanged();
          }
          return result;
        } catch (err) {
          // 写路径不降级：持久化失败必须显式返回失败（上层绝不关闭原标签页），避免双数据源分叉
          console.error('[LocalStashRepository] IndexedDB 写入收纳组失败:', err);
          return { success: false, error: err.message || '写入 IndexedDB 主库失败' };
        }
      }
      return await this._legacyCreateGroup(tabItems, customTitle);
    });
  }

  /**
   * 旧存储实现：整读 → 改 → 整写（调用方已持有跨上下文写锁）
   */
  static async _legacyCreateGroup(tabItems, customTitle = '') {
    const config = await StorageAdapter.getUserConfig();
    const settings = config.stashSettings || {};
    const existingGroups = await this._legacyGetAllGroups();
    let normalizedItems = tabItems.filter((item) => item && item.url);
    if (settings.allowDuplicates === false) {
      const existingUrls = new Set(existingGroups.flatMap((group) => (group.tabs || []).map((tab) => tab.url)));
      const seenIncoming = new Set();
      normalizedItems = normalizedItems.filter((item) => {
        if (existingUrls.has(item.url) || seenIncoming.has(item.url)) return false;
        seenIncoming.add(item.url);
        return true;
      });
      if (settings.existingTabTitleBehavior === 'useLatest') {
        for (const group of existingGroups) {
          for (const tab of group.tabs || []) {
            const incoming = tabItems.find((item) => item?.url === tab.url);
            if (incoming?.title) tab.title = incoming.title;
          }
        }
        await StorageAdapter.set(StorageKeys.STASH_GROUPS, existingGroups);
      }
    }
    if (normalizedItems.length === 0) return { success: true, group: null, skipped: tabItems.length };

    const now = Date.now();
    const dateStr = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(now));

    const defaultTitle = customTitle || `${dateStr} 收纳 (${normalizedItems.length} 个标签页)`;

    const newGroup = {
      id: `stash_grp_${now}_${Math.random().toString(36).substring(2, 7)}`,
      createdAt: now,
      title: defaultTitle,
      locked: false,
      starred: false,
      tabs: normalizedItems.map((item) => ({
        id: `tab_item_${Math.random().toString(36).substring(2, 9)}`,
        url: item.url || '',
        title: item.title || item.url || '无标题页面',
        favIconUrl: item.favIconUrl || '',
        pinned: Boolean(item.pinned)
      }))
    };

    const currentGroups = await this._legacyGetAllGroups();
    currentGroups.unshift(newGroup);

    const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, currentGroups);
    if (ok) {
      await this._runAutoBackupIfEnabled(now);
      await this._notifyStashChanged();
    }
    return { success: ok, group: newGroup };
  }

  /**
   * 更新标签组属性（如标题、锁定、星标）
   * @param {string} groupId
   * @param {Partial<{ title: string, locked: boolean, starred: boolean }>} updates
   * @returns {Promise<boolean>}
   */
  static async updateGroup(groupId, updates) {
    return await IndexedDBManager.withWriteLock(async () => {
      const backend = await this._getBackend();
      if (backend) {
        try {
          const ok = await backend.updateGroup(groupId, updates);
          if (ok) await this._notifyStashChanged();
          return ok;
        } catch (err) {
          console.error('[LocalStashRepository] IndexedDB 更新收纳组失败:', err);
          return false;
        }
      }
      return await this._legacyUpdateGroup(groupId, updates);
    });
  }

  /**
   * 旧存储实现：更新组属性（调用方已持有跨上下文写锁）
   */
  static async _legacyUpdateGroup(groupId, updates) {
    const currentGroups = await this._legacyGetAllGroups();
    const target = currentGroups.find((g) => g.id === groupId);
    if (!target || !updates || typeof updates !== 'object') return false;
    const allowed = ['title', 'locked', 'starred', 'archived'];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        target[key] = key === 'title' ? String(updates[key]).slice(0, 200) : Boolean(updates[key]);
      }
    }
    const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, currentGroups);
    if (ok) await this._notifyStashChanged();
    return ok;
  }

  /**
   * 删除指定的收纳组（若被锁定则不允许删除）
   * @param {string} groupId - 组 ID
   * @param {boolean} [force=false]
   * @returns {Promise<boolean>}
   */
  static async deleteGroup(groupId, force = false) {
    return await IndexedDBManager.withWriteLock(async () => {
      const backend = await this._getBackend();
      if (backend) {
        try {
          const ok = await backend.deleteGroup(groupId, force);
          if (ok) await this._notifyStashChanged();
          return ok;
        } catch (err) {
          console.error('[LocalStashRepository] IndexedDB 删除收纳组失败:', err);
          return false;
        }
      }
      return await this._legacyDeleteGroup(groupId, force);
    });
  }

  /**
   * 旧存储实现：删除收纳组（调用方已持有跨上下文写锁）
   */
  static async _legacyDeleteGroup(groupId, force = false) {
    const currentGroups = await this._legacyGetAllGroups();
    const target = currentGroups.find((g) => g.id === groupId);
    if (target && target.locked && !force) return false;
    const filtered = currentGroups.filter((g) => g.id !== groupId);
    const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, filtered);
    if (ok) await this._notifyStashChanged();
    return ok;
  }

  /**
   * 删除收纳组内的单个标签项
   * @param {string} groupId - 组 ID
   * @param {string} itemId - 标签项 ID
   * @returns {Promise<boolean>}
   */
  static async deleteTabItem(groupId, itemId) {
    return await IndexedDBManager.withWriteLock(async () => {
      const backend = await this._getBackend();
      if (backend) {
        try {
          const ok = await backend.deleteTabItem(groupId, itemId);
          if (ok) await this._notifyStashChanged();
          return ok;
        } catch (err) {
          console.error('[LocalStashRepository] IndexedDB 删除收纳条目失败:', err);
          return false;
        }
      }
      return await this._legacyDeleteTabItem(groupId, itemId);
    });
  }

  /**
   * 旧存储实现：删除收纳组内单个标签项（调用方已持有跨上下文写锁）
   */
  static async _legacyDeleteTabItem(groupId, itemId) {
    const currentGroups = await this._legacyGetAllGroups();
    const targetGroup = currentGroups.find((g) => g.id === groupId);
    if (!targetGroup) return false;
    targetGroup.tabs = targetGroup.tabs.filter((t) => t.id !== itemId);
    let updatedGroups = currentGroups;
    if (targetGroup.tabs.length === 0 && !targetGroup.locked) updatedGroups = currentGroups.filter((g) => g.id !== groupId);
    const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, updatedGroups);
    if (ok) await this._notifyStashChanged();
    return ok;
  }

  /**
   * 向既有收纳组追加单个条目（AI 增强通道：URL 经 OneTabConverter.sanitizeUrl 清洗，按设置去重）
   * @param {string} groupId - 组 ID
   * @param {{ url: string, title?: string, favIconUrl?: string, pinned?: boolean }} tabItem
   * @returns {Promise<{ success: boolean, added?: boolean, item?: any, skipped?: number, error?: string }>}
   */
  static async addTabItemToGroup(groupId, tabItem) {
    if (!tabItem || typeof tabItem !== 'object') {
      return { success: false, error: '条目数据无效' };
    }
    const cleanUrl = OneTabConverter.sanitizeUrl(tabItem.url);
    if (!cleanUrl) return { success: false, error: 'URL 无效或包含不支持的协议' };
    const normalized = {
      url: cleanUrl,
      title: typeof tabItem.title === 'string' ? tabItem.title : '',
      favIconUrl: OneTabConverter.sanitizeUrl(tabItem.favIconUrl) || '',
      pinned: Boolean(tabItem.pinned)
    };

    return await IndexedDBManager.withWriteLock(async () => {
      const backend = await this._getBackend();
      if (backend) {
        try {
          const config = await StorageAdapter.getUserConfig();
          const res = await backend.addTabItemToGroup(groupId, normalized, config.stashSettings || {});
          if (res?.success && res.added) await this._notifyStashChanged();
          return res;
        } catch (err) {
          console.error('[LocalStashRepository] IndexedDB 追加收纳条目失败:', err);
          return { success: false, error: err.message || '写入 IndexedDB 主库失败' };
        }
      }
      return await this._legacyAddTabItemToGroup(groupId, normalized);
    });
  }

  /**
   * 旧存储实现：向既有组追加条目（调用方已持有跨上下文写锁）
   */
  static async _legacyAddTabItemToGroup(groupId, normalized) {
    const currentGroups = await this._legacyGetAllGroups();
    const target = currentGroups.find((g) => g.id === groupId);
    if (!target) return { success: false, error: '收纳组不存在' };

    const config = await StorageAdapter.getUserConfig();
    if (config.stashSettings?.allowDuplicates === false) {
      const exists = currentGroups.some((g) => (g.tabs || []).some((t) => t.url === normalized.url));
      if (exists) return { success: true, added: false, skipped: 1 };
    }

    const newItem = {
      id: `tab_item_${Math.random().toString(36).substring(2, 9)}`,
      url: normalized.url,
      title: normalized.title || normalized.url || '无标题页面',
      favIconUrl: normalized.favIconUrl || '',
      pinned: Boolean(normalized.pinned)
    };
    target.tabs = [...(target.tabs || []), newItem];
    const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, currentGroups);
    if (!ok) return { success: false, error: '写入本地收纳仓储失败' };
    await this._notifyStashChanged();
    return { success: true, added: true, item: newItem };
  }

  /**
   * 编辑既有收纳条目（AI 增强通道）
   * 标题遵循两层模型语义：title 属于页面实体（同 URL 条目共享）；
   * 修改 url 会将条目重新指向新 URL 的页面实体。
   * @param {string} groupId - 组 ID
   * @param {string} itemId - 条目 ID
   * @param {Partial<{ title: string, url: string, pinned: boolean, archived: boolean }>} updates
   * @returns {Promise<boolean>}
   */
  static async updateTabItem(groupId, itemId, updates) {
    if (!itemId || !updates || typeof updates !== 'object') return false;
    const normalized = {};
    if (typeof updates.url === 'string') {
      const cleanUrl = OneTabConverter.sanitizeUrl(updates.url);
      if (!cleanUrl) return false;
      normalized.url = cleanUrl;
    }
    if (typeof updates.title === 'string') normalized.title = updates.title;
    if (typeof updates.pinned === 'boolean') normalized.pinned = updates.pinned;
    if (typeof updates.archived === 'boolean') normalized.archived = updates.archived;
    if (Object.keys(normalized).length === 0) return false;

    return await IndexedDBManager.withWriteLock(async () => {
      const backend = await this._getBackend();
      if (backend) {
        try {
          const ok = await backend.updateTabItem(groupId, itemId, normalized);
          if (ok) await this._notifyStashChanged();
          return ok;
        } catch (err) {
          console.error('[LocalStashRepository] IndexedDB 编辑收纳条目失败:', err);
          return false;
        }
      }
      return await this._legacyUpdateTabItem(groupId, itemId, normalized);
    });
  }

  /**
   * 旧存储实现：编辑条目（调用方已持有跨上下文写锁）
   */
  static async _legacyUpdateTabItem(groupId, itemId, normalized) {
    const currentGroups = await this._legacyGetAllGroups();
    const targetGroup = currentGroups.find((g) => g.id === groupId);
    const target = targetGroup?.tabs?.find((t) => t.id === itemId);
    if (!target) return false;
    if (normalized.url !== undefined) target.url = normalized.url;
    if (normalized.title !== undefined) target.title = normalized.title.slice(0, 4096) || target.url;
    if (normalized.pinned !== undefined) target.pinned = normalized.pinned;
    if (normalized.archived !== undefined) target.archived = normalized.archived;
    const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, currentGroups);
    if (ok) await this._notifyStashChanged();
    return ok;
  }

  /**
   * 清空所有非锁定的历史收纳数据
   * @returns {Promise<boolean>}
   */
  static async clearAll(includeLocked = false) {
    return await IndexedDBManager.withWriteLock(async () => {
      const backend = await this._getBackend();
      if (backend) {
        try {
          const ok = await backend.clearAll(includeLocked);
          if (ok) await this._notifyStashChanged();
          return ok;
        } catch (err) {
          console.error('[LocalStashRepository] IndexedDB 清空收纳数据失败:', err);
          return false;
        }
      }
      return await this._legacyClearAll(includeLocked);
    });
  }

  /**
   * 旧存储实现：清空非锁定收纳数据（调用方已持有跨上下文写锁）
   */
  static async _legacyClearAll(includeLocked = false) {
    const currentGroups = await this._legacyGetAllGroups();
    const remaining = includeLocked ? [] : currentGroups.filter((g) => g.locked);
    const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, remaining);
    if (ok) await this._notifyStashChanged();
    return ok;
  }

  /**
   * 标记收纳组为已归档
   * @param {string} groupId
   * @returns {Promise<boolean>}
   */
  static async markGroupArchived(groupId) {
    return await this.updateGroup(groupId, { archived: true });
  }

  /**
   * 清理标签 URL 完全相同的重复收纳组，锁定组不会被删除。
   * @returns {Promise<{ success: boolean, removedCount: number, groupCountAfter: number, error?: string }>}
   */
  static async deduplicateGroups() {
    return await IndexedDBManager.withWriteLock(async () => {
      const backend = await this._getBackend();
      if (backend) {
        try {
          const res = await backend.deduplicateGroups();
          if (res?.success && res.removedCount > 0) await this._notifyStashChanged();
          return res;
        } catch (err) {
          console.error('[LocalStashRepository] IndexedDB 去重失败:', err);
          return { success: false, removedCount: 0, groupCountAfter: 0, error: err.message || '写入 IndexedDB 主库失败' };
        }
      }
      return await this._legacyDeduplicateGroups();
    });
  }

  /**
   * 旧存储实现：清理重复收纳组（调用方已持有跨上下文写锁）
   */
  static async _legacyDeduplicateGroups() {
    const groups = await this._legacyGetAllGroups();
    const seen = new Set();
    const retained = [];
    let removedCount = 0;

    for (const group of groups) {
      const urls = Array.isArray(group.tabs)
        ? group.tabs.map((tab) => String(tab?.url || '').trim()).filter(Boolean).sort()
        : [];
      const fingerprint = JSON.stringify(urls);

      if (seen.has(fingerprint) && !group.locked) {
        removedCount++;
        continue;
      }

      seen.add(fingerprint);
      retained.push(group);
    }

    if (removedCount === 0) return { success: true, removedCount: 0, groupCountAfter: groups.length };

    const saved = await StorageAdapter.set(StorageKeys.STASH_GROUPS, retained);
    if (saved) await this._notifyStashChanged();
    return saved
      ? { success: true, removedCount, groupCountAfter: retained.length }
      : { success: false, removedCount: 0, groupCountAfter: groups.length, error: '写入本地收纳仓储失败' };
  }

  /**
   * 按关键字全局检索收纳条目（标题 / URL 模糊匹配；AI 增强读取通道）
   * @param {string} keyword
   * @param {number} [limit=100]
   * @returns {Promise<Array<{ groupId: string, itemId: string, url: string, title: string }>>}
   */
  static async searchStash(keyword, limit = 100) {
    const backend = await this._getBackend();
    if (backend) {
      try {
        return await backend.searchEntries(keyword, { limit });
      } catch (err) {
        console.warn('[LocalStashRepository] IndexedDB 检索失败，降级至内存检索:', err);
      }
    }
    return await this._legacySearchStash(keyword, limit);
  }

  /**
   * 旧存储实现：整读后内存检索
   */
  static async _legacySearchStash(keyword, limit = 100) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return [];
    const groups = await this._legacyGetAllGroups();
    const results = [];
    for (const group of groups) {
      for (const tab of group.tabs || []) {
        if (
          String(tab.title || '').toLowerCase().includes(kw) ||
          String(tab.url || '').toLowerCase().includes(kw)
        ) {
          results.push({ groupId: group.id, itemId: tab.id, url: tab.url, title: tab.title });
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  }

  /**
   * 分页读取指定收纳组的条目（AI 增强读取通道，支撑超长组）
   * @param {string} groupId
   * @param {{ offset?: number, limit?: number }} [options]
   * @returns {Promise<{ items: any[], total: number, offset: number, limit: number }>}
   */
  static async getGroupPage(groupId, { offset = 0, limit = 50 } = {}) {
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 50)));
    const backend = await this._getBackend();
    if (backend) {
      try {
        return await backend.getGroupPage(groupId, { offset: safeOffset, limit: safeLimit });
      } catch (err) {
        console.warn('[LocalStashRepository] IndexedDB 分页读取失败，降级至旧存储:', err);
      }
    }
    const groups = await this._legacyGetAllGroups();
    const group = groups.find((g) => g.id === groupId);
    const tabs = group ? group.tabs || [] : [];
    const items = tabs.slice(safeOffset, safeOffset + safeLimit).map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl || '',
      pinned: Boolean(tab.pinned)
    }));
    return { items, total: tabs.length, offset: safeOffset, limit: safeLimit };
  }

  /**
   * 列出本地自动备份快照摘要（AI 增强读取通道；不返回快照正文以控制响应体积）
   * @returns {Promise<Array<{ createdAt: number, groupCount: number, entryCount: number, sizeBytes: number }>>}
   */
  static async listAutoBackups() {
    const backups = await StorageAdapter.get(StorageKeys.AUTO_BACKUPS, []);
    if (!Array.isArray(backups)) return [];
    return backups.map((backup) => ({
      createdAt: backup?.createdAt || 0,
      groupCount: Array.isArray(backup?.groups) ? backup.groups.length : 0,
      entryCount: Array.isArray(backup?.groups)
        ? backup.groups.reduce((sum, g) => sum + (Array.isArray(g?.tabs) ? g.tabs.length : 0), 0)
        : 0,
      sizeBytes: this.estimateBackupBytes([backup])
    }));
  }

  /**
   * 恢复指定自动备份中的收纳组（幂等 upsert，不触碰现有其他组与配置）
   * @param {number} createdAt - 备份快照时间戳
   * @returns {Promise<{ success: boolean, groupCount?: number, error?: string }>}
   */
  static async restoreAutoBackup(createdAt) {
    return await IndexedDBManager.withWriteLock(async () => {
      const backups = await StorageAdapter.get(StorageKeys.AUTO_BACKUPS, []);
      const target = Array.isArray(backups) ? backups.find((b) => b?.createdAt === createdAt) : null;
      if (!target || !Array.isArray(target.groups) || target.groups.length === 0) {
        return { success: false, error: '指定备份不存在或为空' };
      }
      try {
        const backend = await this._getBackend();
        if (backend) {
          const imported = await backend.importGroups(target.groups);
          if (!imported?.success) throw new Error(imported?.error || '写入 IndexedDB 失败');
        } else {
          // 旧存储：按组 id 幂等合并（目标组覆盖同名现有组，其余组不动）
          const currentGroups = await this._legacyGetAllGroups();
          const targetIds = new Set(target.groups.map((g) => g.id));
          const merged = [...target.groups, ...currentGroups.filter((g) => !targetIds.has(g.id))];
          const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, merged);
          if (!ok) throw new Error('写入本地收纳仓储失败');
        }
        await this._notifyStashChanged();
        return { success: true, groupCount: target.groups.length };
      } catch (err) {
        console.error('[LocalStashRepository] 恢复自动备份失败:', err);
        return { success: false, error: err.message || '恢复备份失败' };
      }
    });
  }

  /**
   * 删除指定自动备份快照
   * @param {number} createdAt - 备份快照时间戳
   * @returns {Promise<{ success: boolean, remaining?: number, error?: string }>}
   */
  static async deleteAutoBackup(createdAt) {
    return await IndexedDBManager.withWriteLock(async () => {
      const backups = await StorageAdapter.get(StorageKeys.AUTO_BACKUPS, []);
      if (!Array.isArray(backups)) return { success: false, error: '备份列表不存在' };
      const filtered = backups.filter((b) => b?.createdAt !== createdAt);
      if (filtered.length === backups.length) return { success: false, error: '指定备份不存在' };
      const ok = await StorageAdapter.set(StorageKeys.AUTO_BACKUPS, filtered);
      return ok
        ? { success: true, remaining: filtered.length }
        : { success: false, error: '写入备份仓储失败' };
    });
  }

  /**
   * 导出所有收纳数据为 JSON 字符串 (基础版)
   * @returns {Promise<string>}
   */
  static async exportDataJSON() {
    return await this.exportFullBackupJSON();
  }

  /**
   * 导出 BetterBrowse 全量备份 (包含所有收纳标签组 + 插件全局配置 + 域名跳转偏好规则)
   * @returns {Promise<string>}
   */
  static async exportFullBackupJSON() {
    const [groups, config, linkRules] = await Promise.all([
      this.getAllGroups(),
      StorageAdapter.getUserConfig(),
      StorageAdapter.get(StorageKeys.LINK_RULES, {})
    ]);

    return JSON.stringify(
      {
        version: 1,
        exportedAt: Date.now(),
        plugin: 'BetterBrowse',
        type: 'full_backup',
        config: config,
        linkRules: linkRules,
        globalLinkRule: config.globalLinkRule || { enabled: false, mode: 'auto' },
        stashGroups: groups
      },
      null,
      2
    );
  }

  /**
   * 导出所有收纳数据为 OneTab 兼容的纯文本格式 (URL | Title)
   * @returns {Promise<string>}
   */
  static async exportToOneTabText() {
    const groups = await this.getAllGroups();
    return OneTabConverter.exportToOneTabText(groups);
  }

  /**
   * 恢复 BetterBrowse 全量数据 (完整还原标签组 + 插件配置 + 域名规则)
   * @param {string} rawInputString - 备份 JSON 文本
   * @returns {Promise<{ success: boolean, importedCount: number, groupCount: number, restoredConfig: boolean, restoredRules: boolean, error?: string }>}
   */
  static async restoreFullBackupJSON(rawInputString) {
    if (!rawInputString || typeof rawInputString !== 'string') {
      return { success: false, importedCount: 0, groupCount: 0, restoredConfig: false, restoredRules: false, error: '输入内容为空' };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(rawInputString.trim());
    } catch {
      // 若非标准 JSON，降级使用 autoParse 解析标签
    }

    let restoredConfig = false;
    let restoredRules = false;

    // 1. 如果包含插件配置信息，无缝恢复插件设置与全局规则
    if (parsed && typeof parsed === 'object') {
      const configToRestore = parsed.config && typeof parsed.config === 'object' ? { ...parsed.config } : {};
      if (parsed.globalLinkRule && typeof parsed.globalLinkRule === 'object') {
        configToRestore.globalLinkRule = parsed.globalLinkRule;
      }

      const safeConfig = {};
      const scalarKeys = ['tabThreshold', 'autoThresholdNotify', 'autoStashOnThreshold', 'countdownSeconds', 'thresholdCooldownMinutes', 'recentActiveMinutes', 'frequencyPercentile', 'frequencyHistoryMinutes'];
      for (const key of scalarKeys) if (Object.prototype.hasOwnProperty.call(configToRestore, key)) safeConfig[key] = configToRestore[key];
      if (configToRestore.rulesEnabled && typeof configToRestore.rulesEnabled === 'object') safeConfig.rulesEnabled = configToRestore.rulesEnabled;
      if (configToRestore.globalLinkRule && typeof configToRestore.globalLinkRule === 'object') safeConfig.globalLinkRule = configToRestore.globalLinkRule;
      if (configToRestore.stashSettings && typeof configToRestore.stashSettings === 'object') safeConfig.stashSettings = configToRestore.stashSettings;
      if (configToRestore.tieredStash && typeof configToRestore.tieredStash === 'object') safeConfig.tieredStash = configToRestore.tieredStash;
      if (Object.keys(safeConfig).length > 0 || (parsed.linkRules && typeof parsed.linkRules === 'object')) {
        await IndexedDBManager.withWriteLock(async () => {
          if (Object.keys(safeConfig).length > 0) {
            restoredConfig = await StorageAdapter.updateUserConfigUnlocked(safeConfig);
          }
          if (parsed.linkRules && typeof parsed.linkRules === 'object') {
            const safeRules = {};
            for (const [domain, mode] of Object.entries(parsed.linkRules)) {
              if (/^[a-z0-9.-]+$/i.test(domain) && ['auto', 'current', 'new'].includes(mode)) {
                safeRules[domain.toLowerCase()] = mode;
              }
            }
            restoredRules = await StorageAdapter.set(StorageKeys.LINK_RULES, safeRules);
          }
        });
      }
    }

    // 2. 恢复收纳标签组数据
    const tabImportResult = await this.importDataJSON(rawInputString);
    if (!tabImportResult.success) {
      if (restoredConfig || restoredRules) {
        return {
          success: true,
          importedCount: 0,
          groupCount: 0,
          restoredConfig,
          restoredRules
        };
      }
      return {
        success: false,
        importedCount: 0,
        groupCount: 0,
        restoredConfig: false,
        restoredRules: false,
        error: tabImportResult.error || '未能解析出有效数据'
      };
    }

    return {
      success: true,
      importedCount: tabImportResult.importedCount,
      groupCount: tabImportResult.groupCount,
      restoredConfig,
      restoredRules
    };
  }

  /**
   * 从第三方工具导入标签数据（如 OneTab 纯文本、OneTab 内部数据、纯 URL 列表）
   * 严格仅导入标签组，绝不改动任何插件设置
   * @param {string} rawInputString - 第三方数据文本
   * @returns {Promise<{ success: boolean, importedCount: number, groupCount: number, formatName: string, error?: string }>}
   */
  static async importThirdPartyData(rawInputString) {
    return await this.importDataJSON(rawInputString);
  }

  /**
   * 智能导入收纳数据（自动识别 OneTab 文本、OneTab 内部数据与 Better Browse JSON）
   * 解析与清洗在锁外完成，写入在写锁临界区内按当前生效后端执行
   * @param {string} rawInputString - 文本或 JSON
   * @returns {Promise<{ success: boolean, importedCount: number, groupCount: number, formatName: string, error?: string }>}
   */
  static async importDataJSON(rawInputString) {
    const result = OneTabConverter.autoParse(rawInputString);

    if (!result.success || result.groups.length === 0) {
      return {
        success: false,
        importedCount: 0,
        groupCount: 0,
        formatName: result.formatName,
        error: result.error || '未能识别出有效的标签页数据'
      };
    }

    const { validImportedGroups, importedCount } = this._normalizeImportedGroups(result.groups);
    if (validImportedGroups.length === 0) {
      return {
        success: false,
        importedCount: 0,
        groupCount: 0,
        formatName: result.formatName,
        error: '未能从输入中提取出有效的网页链接'
      };
    }

    return await IndexedDBManager.withWriteLock(async () => {
      const backend = await this._getBackend();
      if (backend) {
        try {
          const imported = await backend.importGroups(validImportedGroups);
          if (!imported?.success) {
            throw new Error(imported?.error || '写入 IndexedDB 失败');
          }
          await this._notifyStashChanged();
          return {
            success: true,
            importedCount,
            groupCount: validImportedGroups.length,
            formatName: result.formatName
          };
        } catch (err) {
          // 写路径不降级：导入失败显式返回，由用户决定是否重试
          console.error('[LocalStashRepository] IndexedDB 导入失败:', err);
          return {
            success: false,
            importedCount: 0,
            groupCount: 0,
            formatName: result.formatName,
            error: err.message || '写入 IndexedDB 主库失败'
          };
        }
      }
      return await this._legacyImportGroups(validImportedGroups, importedCount, result.formatName);
    });
  }

  /**
   * 恢复单个收纳组快照（撤销删除专用轻量通道）
   * 与 importDataJSON / restoreFullBackupJSON 的"追加导入"不同，本方法仅写入被恢复的这一个组，
   * 绝不触碰现有组数据，也绝不触发配置/规则恢复管线。
   * entryId 由主键推导幂等写入，重复恢复同一快照不会产生重复条目。
   * @param {{ id?: string, tabs?: any[], title?: string, createdAt?: number, locked?: boolean, starred?: boolean }} snapshotGroup
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  static async restoreGroupSnapshot(snapshotGroup) {
    if (!snapshotGroup || typeof snapshotGroup !== 'object' || !snapshotGroup.id || !Array.isArray(snapshotGroup.tabs)) {
      return { success: false, error: '恢复数据结构无效' };
    }
    const group = {
      id: snapshotGroup.id,
      createdAt: typeof snapshotGroup.createdAt === 'number' ? snapshotGroup.createdAt : Date.now(),
      title: typeof snapshotGroup.title === 'string' ? snapshotGroup.title.slice(0, 200) : '',
      locked: Boolean(snapshotGroup.locked),
      starred: Boolean(snapshotGroup.starred),
      tabs: snapshotGroup.tabs
    };

    return await IndexedDBManager.withWriteLock(async () => {
      const backend = await this._getBackend();
      if (backend) {
        try {
          const imported = await backend.importGroups([group]);
          if (!imported?.success) {
            throw new Error(imported?.error || '写入 IndexedDB 失败');
          }
          await this._notifyStashChanged();
          return { success: true };
        } catch (err) {
          console.error('[LocalStashRepository] 恢复收纳组快照失败:', err);
          return { success: false, error: err.message || '写入 IndexedDB 主库失败' };
        }
      }
      try {
        const currentGroups = await this._legacyGetAllGroups();
        const mergedGroups = [group, ...currentGroups.filter((g) => g.id !== group.id)];
        const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, mergedGroups);
        if (ok) await this._notifyStashChanged();
        return ok ? { success: true } : { success: false, error: '写入本地收纳仓储失败' };
      } catch (err) {
        return { success: false, error: err.message || '写入本地收纳仓储失败' };
      }
    });
  }

  /**
   * 将解析结果规范化为可入库的组结构（URL 清洗、协议过滤、脏数据剔除）
   * @param {Array<{ tabs: any[], createdAt?: number, title?: string, id?: string, locked?: boolean, starred?: boolean }>} parsedGroups
   * @returns {{ validImportedGroups: any[], importedCount: number }}
   */
  static _normalizeImportedGroups(parsedGroups) {
    const validImportedGroups = [];
    let importedCount = 0;

    for (let i = 0; i < parsedGroups.length; i++) {
      const grp = parsedGroups[i];
      if (grp && Array.isArray(grp.tabs) && grp.tabs.length > 0) {
        const createdAt = typeof grp.createdAt === 'number' ? grp.createdAt : Date.now() - i * 1000;
        const dateStr = new Intl.DateTimeFormat('zh-CN', {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(new Date(createdAt));

        const validTabs = [];
        for (const t of grp.tabs) {
          if (!t) continue;
          const cleanUrl = OneTabConverter.sanitizeUrl(t.url);
          if (!cleanUrl) continue;

          validTabs.push({
            id: t.id || `tab_item_${Math.random().toString(36).substring(2, 9)}`,
            url: cleanUrl,
            title: typeof t.title === 'string' && t.title.trim() ? t.title.slice(0, 4096) : cleanUrl,
            favIconUrl: OneTabConverter.sanitizeUrl(t.favIconUrl) || '',
            pinned: Boolean(t.pinned),
            archived: Boolean(t.archived)
          });
        }

        if (validTabs.length === 0) continue;

        const validGroup = {
          id: grp.id || `stash_grp_${createdAt}_${Math.random().toString(36).substring(2, 7)}`,
          createdAt: createdAt,
          title: grp.title || `${dateStr} 收纳 (${validTabs.length} 个标签页)`,
          locked: Boolean(grp.locked),
          starred: Boolean(grp.starred),
          tabs: validTabs
        };
        validImportedGroups.push(validGroup);
        importedCount += validGroup.tabs.length;
      }
    }

    return { validImportedGroups, importedCount };
  }

  /**
   * 旧存储实现：导入组正向拼接进现有数组（调用方已持有跨上下文写锁）
   */
  static async _legacyImportGroups(validImportedGroups, importedCount, formatName) {
    const currentGroups = await this._legacyGetAllGroups();
    // 保持导入组本身的先后顺序（正向拼接在现有组之前）
    const mergedGroups = [...validImportedGroups, ...currentGroups];
    const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, mergedGroups);
    if (ok) await this._notifyStashChanged();
    return ok
      ? { success: true, importedCount, groupCount: validImportedGroups.length, formatName }
      : { success: false, importedCount: 0, groupCount: 0, formatName, error: '写入本地收纳仓储失败' };
  }
}
