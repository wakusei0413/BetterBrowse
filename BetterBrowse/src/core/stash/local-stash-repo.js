/**
 * @file local-stash-repo.js
 * @description 本地标签页收纳仓储（支持分组、星标、锁定、重命名、搜索与 OneTab 无缝双向互导）
 * @encoding UTF-8
 */

import { StorageKeys } from '../../constants/storage-keys.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { OneTabConverter } from './onetab-converter.js';

export class LocalStashRepository {
  /**
   * 获取所有已保存的收纳标签组列表（默认按时间倒序）
   * @returns {Promise<Array<{ id: string, createdAt: number, title: string, locked?: boolean, starred?: boolean, tabs: Array<{ id: string, url: string, title: string, favIconUrl?: string, pinned?: boolean }> }>>}
   */
  static async getAllGroups() {
    const groups = await StorageAdapter.get(StorageKeys.STASH_GROUPS, []);
    if (!Array.isArray(groups)) return [];
    return groups.sort((a, b) => {
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

    const now = Date.now();
    const dateStr = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(now));

    const defaultTitle = customTitle || `${dateStr} 收纳 (${tabItems.length} 个标签页)`;

    const newGroup = {
      id: `stash_grp_${now}_${Math.random().toString(36).substring(2, 7)}`,
      createdAt: now,
      title: defaultTitle,
      locked: false,
      starred: false,
      tabs: tabItems.map((item) => ({
        id: `tab_item_${Math.random().toString(36).substring(2, 9)}`,
        url: item.url || '',
        title: item.title || item.url || '无标题页面',
        favIconUrl: item.favIconUrl || '',
        pinned: Boolean(item.pinned)
      }))
    };

    const currentGroups = await this.getAllGroups();
    currentGroups.unshift(newGroup);

    const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, currentGroups);
    return { success: ok, group: newGroup };
  }

  /**
   * 更新标签组属性（如标题、锁定、星标）
   * @param {string} groupId
   * @param {Partial<{ title: string, locked: boolean, starred: boolean }>} updates
   * @returns {Promise<boolean>}
   */
  static async updateGroup(groupId, updates) {
    const currentGroups = await this.getAllGroups();
    const target = currentGroups.find((g) => g.id === groupId);
    if (!target) return false;

    Object.assign(target, updates);
    return await StorageAdapter.set(StorageKeys.STASH_GROUPS, currentGroups);
  }

  /**
   * 删除指定的收纳组（若被锁定则不允许删除）
   * @param {string} groupId - 组 ID
   * @param {boolean} [force=false]
   * @returns {Promise<boolean>}
   */
  static async deleteGroup(groupId, force = false) {
    const currentGroups = await this.getAllGroups();
    const target = currentGroups.find((g) => g.id === groupId);
    if (target && target.locked && !force) {
      return false; // 锁定状态禁止误删
    }
    const filtered = currentGroups.filter((g) => g.id !== groupId);
    return await StorageAdapter.set(StorageKeys.STASH_GROUPS, filtered);
  }

  /**
   * 删除收纳组内的单个标签项
   * @param {string} groupId - 组 ID
   * @param {string} itemId - 标签项 ID
   * @returns {Promise<boolean>}
   */
  static async deleteTabItem(groupId, itemId) {
    const currentGroups = await this.getAllGroups();
    const targetGroup = currentGroups.find((g) => g.id === groupId);
    if (!targetGroup) return false;

    targetGroup.tabs = targetGroup.tabs.filter((t) => t.id !== itemId);

    // 若非锁定组且所有标签已被删空，则自动移除空组
    let updatedGroups = currentGroups;
    if (targetGroup.tabs.length === 0 && !targetGroup.locked) {
      updatedGroups = currentGroups.filter((g) => g.id !== groupId);
    }

    return await StorageAdapter.set(StorageKeys.STASH_GROUPS, updatedGroups);
  }

  /**
   * 清空所有非锁定的历史收纳数据
   * @returns {Promise<boolean>}
   */
  static async clearAll(includeLocked = false) {
    if (includeLocked) {
      return await StorageAdapter.set(StorageKeys.STASH_GROUPS, []);
    }
    const currentGroups = await this.getAllGroups();
    const lockedOnly = currentGroups.filter((g) => g.locked);
    return await StorageAdapter.set(StorageKeys.STASH_GROUPS, lockedOnly);
  }

  /**
   * 导出所有收纳数据为 JSON 字符串
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

      if (Object.keys(configToRestore).length > 0) {
        await StorageAdapter.updateUserConfig(configToRestore);
        restoredConfig = true;
      }

      if (parsed.linkRules && typeof parsed.linkRules === 'object') {
        await StorageAdapter.set(StorageKeys.LINK_RULES, parsed.linkRules);
        restoredRules = true;
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

    const currentGroups = await this.getAllGroups();
    let importedCount = 0;
    const validImportedGroups = [];

    for (let i = 0; i < result.groups.length; i++) {
      const grp = result.groups[i];
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
        const validGroup = {
          id: grp.id || `stash_grp_${createdAt}_${Math.random().toString(36).substring(2, 7)}`,
          createdAt: createdAt,
          title: grp.title || `${dateStr} 收纳 (${grp.tabs.length} 个标签页)`,
          locked: Boolean(grp.locked),
          starred: Boolean(grp.starred),
          tabs: grp.tabs.map((t) => ({
            id: t.id || `tab_item_${Math.random().toString(36).substring(2, 9)}`,
            url: t.url || '',
            title: t.title || t.url || '无标题页面',
            favIconUrl: t.favIconUrl || '',
            pinned: Boolean(t.pinned)
          }))
        };
        validImportedGroups.push(validGroup);
        importedCount += validGroup.tabs.length;
      }
    }

    // 保持导入组本身的先后顺序（正向拼接在现有组之前，彻底解决 unshift 导致的方向倒置）
    const mergedGroups = [...validImportedGroups, ...currentGroups];

    await StorageAdapter.set(StorageKeys.STASH_GROUPS, mergedGroups);

    return {
      success: true,
      importedCount,
      groupCount: validImportedGroups.length,
      formatName: result.formatName
    };
  }
}
