/**
 * @file migration.js
 * @description 存储架构版本迁移管理器（确保未来数据结构升级向后兼容）
 * @encoding UTF-8
 */

import { StorageKeys } from '../../constants/storage-keys.js';
import { CURRENT_SCHEMA_VERSION, DefaultConfig } from '../../constants/config.js';
import { StorageAdapter } from './storage-adapter.js';

export class MigrationManager {
  /**
   * 执行初始化与升级迁移检查
   */
  static async runMigrations() {
    const currentVersion = await StorageAdapter.get(StorageKeys.SCHEMA_VERSION, 0);

    if (currentVersion === CURRENT_SCHEMA_VERSION) {
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
      // 迁移 v1/v2 到 v3：平滑补齐 stashSettings 缺失字段
      const existingConfig = await StorageAdapter.get(StorageKeys.USER_CONFIG, {});
      const mergedConfig = {
        ...DefaultConfig,
        ...existingConfig,
        stashSettings: {
          ...DefaultConfig.stashSettings,
          ...(existingConfig.stashSettings || {})
        }
      };
      await StorageAdapter.set(StorageKeys.USER_CONFIG, mergedConfig);
    }

    // 记录最新版本号
    await StorageAdapter.set(StorageKeys.SCHEMA_VERSION, CURRENT_SCHEMA_VERSION);
    console.info(`[MigrationManager] 数据架构迁移完成，当前版本: v${CURRENT_SCHEMA_VERSION}`);
  }
}

