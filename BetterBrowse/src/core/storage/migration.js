/**
 * @file migration.js
 * @description 存储架构版本迁移管理器（幂等、可中断恢复、失败降级回旧存储，详见 docs/01-local-indexeddb.md 第 2.2 节）
 * @encoding UTF-8
 */

import { StorageKeys } from '../../constants/storage-keys.js';
import { CURRENT_SCHEMA_VERSION, DefaultConfig } from '../../constants/config.js';
import { StorageAdapter } from './storage-adapter.js';
import { IndexedDBManager } from './indexed-db.js';
import { IndexedStashRepository } from '../stash/indexed-stash-repo.js';

/** 迁移成功后旧 chrome.storage.local 数据的并行保留天数（期间可一键回退） */
const LEGACY_STASH_RETENTION_DAYS = 30;

export class MigrationManager {
  /**
   * 执行初始化与升级迁移检查
   *
   * 关键语义：
   * - 幂等可重入：每个迁移块以 if (currentVersion < N) 包裹，重复执行不产生副作用；
   * - 失败降级：IndexedDB 迁移失败时版本号停在 v4，旧数据完整保留，下次启动自动重试；
   * - 原子切换：v5 迁移的"读旧数组 → 写 IndexedDB → 版本推进"在同一把跨上下文写锁内完成，
   *   迁移期间并发写入旧存储不会被漏拷；
   * - 30 天保留：迁移成功后旧数组保留 30 天再清理，期间可一键回退。
   */
  static async runMigrations() {
    const currentVersion = await StorageAdapter.get(StorageKeys.SCHEMA_VERSION, 0);

    if (currentVersion === CURRENT_SCHEMA_VERSION) {
      // 已是最新版本：仅需检查旧数据保留期是否到期
      await this.cleanupLegacyStashData(currentVersion);
      return;
    }

    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      console.warn(`[MigrationManager] 检测到更高数据版本 v${currentVersion}，当前版本 v${CURRENT_SCHEMA_VERSION} 不执行降级覆盖`);
      return;
    }

    console.info(`[MigrationManager] 正在将数据架构从 v${currentVersion} 迁移至 v${CURRENT_SCHEMA_VERSION}...`);

    if (currentVersion === 0) {
      // 首次安装，初始化默认数据结构
      const existingConfig = await StorageAdapter.get(StorageKeys.USER_CONFIG, null);
      if (!existingConfig) {
        await StorageAdapter.set(StorageKeys.USER_CONFIG, DefaultConfig);
      }

      const existingLinkRules = await StorageAdapter.get(StorageKeys.LINK_RULES, null);
      if (!existingLinkRules) {
        await StorageAdapter.set(StorageKeys.LINK_RULES, {});
      }

      const existingStash = await StorageAdapter.get(StorageKeys.STASH_GROUPS, null);
      if (!existingStash) {
        await StorageAdapter.set(StorageKeys.STASH_GROUPS, []);
      }
    }

    if (currentVersion < 3) {
      // 迁移 v1/v2 到 v3：平滑补齐收纳箱设置，保留用户已有值。
      await this._mergeUserConfig();
    }

    if (currentVersion < 4) {
      // 迁移 v1/v2/v3 到 v4：平滑补齐"阶梯式降级收纳"默认配置，保留用户已有值。
      await this._mergeUserConfig();
    }

    // v5：收纳组数据迁移至 IndexedDB 本地主库（阶段一垂直切片）
    let targetVersion = 4;
    if (currentVersion < 5) {
      const optedOut = (await StorageAdapter.get(StorageKeys.IDB_OPTOUT, false)) === true;
      if (optedOut) {
        // 用户已显式回退旧存储：跳过 IndexedDB 迁移，仅推进版本号
        targetVersion = 5;
      } else if (await this.migrateStashGroupsToIndexedDB()) {
        targetVersion = 5;
        await StorageAdapter.set(StorageKeys.IDB_MIGRATED_AT, Date.now());
      } else {
        // IndexedDB 不可用或迁移失败：版本停在 v4，旧数据完整保留，下次启动自动重试
        targetVersion = 4;
      }
    }

    await StorageAdapter.set(StorageKeys.SCHEMA_VERSION, targetVersion);
    console.info(`[MigrationManager] 数据架构迁移完成，当前版本: v${targetVersion}`);
    await this.cleanupLegacyStashData(targetVersion);
  }

  /**
   * 以默认配置为基础深度合并用户已有配置（v3/v4 迁移共用）
   */
  static async _mergeUserConfig() {
    const existingConfig = await StorageAdapter.get(StorageKeys.USER_CONFIG, {});
    const mergedConfig = {
      ...DefaultConfig,
      ...existingConfig,
      rulesEnabled: {
        ...DefaultConfig.rulesEnabled,
        ...(existingConfig.rulesEnabled || {})
      },
      globalLinkRule: {
        ...DefaultConfig.globalLinkRule,
        ...(existingConfig.globalLinkRule || {})
      },
      stashSettings: {
        ...DefaultConfig.stashSettings,
        ...(existingConfig.stashSettings || {})
      },
      tieredStash: {
        ...DefaultConfig.tieredStash,
        ...(existingConfig.tieredStash || {})
      }
    };
    await StorageAdapter.set(StorageKeys.USER_CONFIG, mergedConfig);
  }

  /**
   * v5 迁移：将 chrome.storage.local 中的旧版收纳组数组搬运至 IndexedDB 主库
   * 整个过程持有跨上下文写锁，与旧存储写入路径（同样持锁）互斥，杜绝漏拷。
   * @returns {Promise<boolean>} 是否迁移成功（无旧数据视为成功）
   */
  static async migrateStashGroupsToIndexedDB() {
    if (!IndexedStashRepository.isSupported()) {
      console.info('[MigrationManager] 当前环境不支持 IndexedDB，v5 主库迁移延后重试');
      return false;
    }
    try {
      return await IndexedDBManager.withWriteLock(async () => {
        const legacyGroups = await StorageAdapter.get(StorageKeys.STASH_GROUPS, []);
        if (!Array.isArray(legacyGroups) || legacyGroups.length === 0) {
          // 无旧数据需要搬运（首次安装），直接完成版本切换
          return true;
        }

        // 已持锁：importGroups 为无锁实现，由本临界区保证串行
        const imported = await IndexedStashRepository.importGroups(legacyGroups);
        if (!imported?.success) {
          console.warn('[MigrationManager] IndexedDB 写入未成功，将于下次启动重试');
          return false;
        }

        // 完整性校验：所有携带主键的旧组都必须成功落入 IndexedDB，
        // 半途被 Service Worker 休眠打断的迁移会在校验中暴露并整体重试
        const migratedGroups = await IndexedStashRepository.getAllGroups();
        const migratedIds = new Set(migratedGroups.map((group) => group.id));
        const allPresent = legacyGroups
          .filter((group) => group?.id)
          .every((group) => migratedIds.has(group.id));
        if (!allPresent) {
          console.warn('[MigrationManager] IndexedDB 迁移完整性校验未通过，将于下次启动重试');
          return false;
        }

        console.info(
          `[MigrationManager] 已将 ${imported.groupCount} 个收纳组、${imported.entryCount} 条收纳记录迁移至 IndexedDB 主库（旧数据保留 ${LEGACY_STASH_RETENTION_DAYS} 天）`
        );
        return true;
      });
    } catch (err) {
      console.warn('[MigrationManager] IndexedDB 迁移执行异常，将于下次启动重试:', err);
      return false;
    }
  }

  /**
   * 清理超过保留期的旧版收纳数组（迁移成功 30 天后执行）
   * @param {number} currentVersion - 当前生效的版本号
   */
  static async cleanupLegacyStashData(currentVersion) {
    if (Number(currentVersion) < 5) return;
    const migratedAt = await StorageAdapter.get(StorageKeys.IDB_MIGRATED_AT, 0);
    if (!migratedAt) return; // 未迁移或已回退（回退会清零该标记），不清理旧数据
    if (Date.now() - migratedAt < LEGACY_STASH_RETENTION_DAYS * 86400000) return;

    const legacyGroups = await StorageAdapter.get(StorageKeys.STASH_GROUPS, []);
    if (Array.isArray(legacyGroups) && legacyGroups.length > 0) {
      // 先广播收纳数据变更通知（选项页监听修订号刷新显示），再清空旧数组
      await StorageAdapter.set(
        StorageKeys.STASH_REV,
        `${Date.now()}_legacy_cleanup_${Math.random().toString(36).slice(2, 7)}`
      );
      await StorageAdapter.set(StorageKeys.STASH_GROUPS, []);
      console.info('[MigrationManager] 旧版 chrome.storage.local 收纳数据已超过保留期，完成清理');
    }
  }

  /**
   * 一键回退：将 IndexedDB 主库中的收纳组整体导回 chrome.storage.local 旧数组，
   * 并设置回退标记（此后数据源固定为旧存储，迁移不会自动切回）。
   * 适用于迁移后发现异常、需要立刻回到旧存储的人工应急场景。
   * @returns {Promise<{ success: boolean, groupCount?: number, error?: string }>}
   */
  static async rollbackFromIndexedDB() {
    if (!IndexedStashRepository.isSupported()) {
      return { success: false, error: '当前环境不支持 IndexedDB' };
    }
    try {
      const groups = await IndexedStashRepository.getAllGroups();
      const ok = await StorageAdapter.set(StorageKeys.STASH_GROUPS, groups);
      if (!ok) {
        return { success: false, error: '写回 chrome.storage.local 失败' };
      }
      await StorageAdapter.set(StorageKeys.IDB_OPTOUT, true);
      await StorageAdapter.set(StorageKeys.IDB_MIGRATED_AT, 0);
      // 广播变更，让打开中的选项页立即切换到旧存储数据源
      await StorageAdapter.set(
        StorageKeys.STASH_REV,
        `${Date.now()}_rollback_${Math.random().toString(36).slice(2, 7)}`
      );
      console.info(`[MigrationManager] 已从 IndexedDB 回退至 chrome.storage.local 旧存储（共 ${groups.length} 组）`);
      return { success: true, groupCount: groups.length };
    } catch (err) {
      console.warn('[MigrationManager] IndexedDB 回退执行异常:', err);
      return { success: false, error: err.message };
    }
  }
}
