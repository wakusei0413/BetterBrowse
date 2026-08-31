/**
 * @file migration.js
 * @description 存储架构修订迁移管理器（幂等、可中断恢复、失败降级回旧存储，详见 docs/01-local-indexeddb.md 第 2.2 节）
 * @encoding UTF-8
 */

import { StorageKeys } from '../../constants/storage-keys.js';
import { LOCAL_DATA_SCHEMA_REVISION, DefaultConfig } from '../../constants/config.js';
import { StorageAdapter } from './storage-adapter.js';
import { IndexedDBManager, IDBStores, INDEXED_DB_SCHEMA_REVISION } from './indexed-db.js';
import { IndexedStashRepository } from '../stash/indexed-stash-repo.js';
import { SYNC_CLOCK_KEY } from '../sync/sync-constants.js';

/** 迁移成功后旧 chrome.storage.local 数据的并行保留天数（期间可一键回退） */
const LEGACY_STASH_RETENTION_DAYS = 30;

export class MigrationManager {
  /**
   * 自愈修复：磁盘库存在但业务对象仓储缺失时，通过结构修订升级重建全部仓储并回填旧存储收纳数据。
   *
   * 背景：IndexedDB 拒绝用低于现存结构修订号的值打开（VersionError），且"仅抬高结构修订号的裸打开"
   * 会产生一个结构修订号很高但没有任何对象仓储的空库——此后所有业务读写抛 NotFoundError，
   * 收纳读写全靠旧存储兜底，同步引擎则因仓储缺失陷入无限重试。
   * 修复方式：以 INDEXED_DB_SCHEMA_REVISION 打开（高于残留版本时触发 upgradeneeded，_ensureSchema 幂等建表），
   * 随后若主库收纳组为空且数据架构已进入 IndexedDB 时代（schema ≥ 5），从旧存储幂等回填。
   * 主库已有数据时直接返回，无任何副作用。
   * @returns {Promise<void>}
   */
  static async repairMissingObjectStores() {
    if (!IndexedDBManager.isSupported()) return;
    try {
      // 打开（必要时升级建表）：磁盘残留修订低于 INDEXED_DB_SCHEMA_REVISION 时触发 upgradeneeded 重建全部仓储
      await IndexedDBManager.open();

      const groupCount = await IndexedDBManager.runTransaction([IDBStores.STASH_GROUPS], 'readonly', async (tx) => {
        return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.STASH_GROUPS).count());
      });
      if (groupCount > 0) return; // 主库已有数据：结构健康，无需修复

      // 数据架构尚未进入 IndexedDB 时代：旧数据由正式迁移管线（本地数据修订 5、7、8）负责回填，此处不抢
      const schemaVersion = Number(await StorageAdapter.get(StorageKeys.SCHEMA_VERSION, 0));
      if (schemaVersion < 5) return;

      const legacyGroups = await StorageAdapter.get(StorageKeys.STASH_GROUPS, []);
      if (Array.isArray(legacyGroups) && legacyGroups.length > 0) {
        const imported = await IndexedStashRepository.importGroups(legacyGroups);
        console.info(`[MigrationManager] 自愈修复完成：已重建 IndexedDB 结构并回填 ${imported.groupCount} 个收纳组（${imported.entryCount} 条记录）`);
      } else {
        console.info('[MigrationManager] 自愈修复完成：IndexedDB 结构已重建（旧存储无收纳数据）');
      }
    } catch (err) {
      // 自愈失败不阻塞迁移主流程（旧存储兜底仍然可用）
      console.warn('[MigrationManager] 自愈修复失败（不阻塞主流程）:', err?.message || err);
    }
  }

  /**
   * 执行初始化与升级迁移检查
   *
   * 关键语义：
   * - 幂等可重入：每个迁移块以 if (currentVersion < N) 包裹，重复执行不产生副作用；
   * - 失败降级：IndexedDB 迁移失败时本地数据修订停在 4，旧数据完整保留，下次启动自动重试；
   * - 原子切换：本地数据修订 5 迁移的"读旧数组 → 写 IndexedDB → 修订推进"在同一把跨上下文写锁内完成，
   *   迁移期间并发写入旧存储不会被漏拷；
   * - 30 天保留：迁移成功后旧数组保留 30 天再清理，期间可一键回退。
   */
  static async runMigrations() {
    // 自愈修复：磁盘库存在但业务仓储缺失时重建结构并回填旧存储数据（幂等，见方法文档）
    await this.repairMissingObjectStores();

    const currentVersion = await StorageAdapter.get(StorageKeys.SCHEMA_VERSION, 0);

    if (currentVersion === LOCAL_DATA_SCHEMA_REVISION) {
      // 已是最新版本：仅需检查旧数据保留期是否到期
      await this.cleanupLegacyStashData(currentVersion);
      return;
    }

    if (currentVersion > LOCAL_DATA_SCHEMA_REVISION) {
      console.warn(`[MigrationManager] 检测到更高的本地数据修订 ${currentVersion}，当前支持修订 ${LOCAL_DATA_SCHEMA_REVISION} 不执行降级覆盖`);
      return;
    }

    console.info(`[MigrationManager] 正在将本地数据修订从 ${currentVersion} 迁移至 ${LOCAL_DATA_SCHEMA_REVISION}...`);

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
      // 从本地数据修订 1、2 迁移到修订 3：平滑补齐收纳箱设置，保留用户已有值。
      await this._mergeUserConfig();
    }

    if (currentVersion < 4) {
      // 从本地数据修订 1、2、3 迁移到修订 4：平滑补齐"阶梯式降级收纳"默认配置，保留用户已有值。
      await this._mergeUserConfig();
    }

    // 本地数据修订 5：收纳组数据迁移至 IndexedDB 本地主库（阶段一垂直切片）
    let targetVersion = currentVersion;
    if (currentVersion < 5) {
      const optedOut = (await StorageAdapter.get(StorageKeys.IDB_OPTOUT, false)) === true;
      if (optedOut) {
        // 用户已显式回退旧存储：跳过 IndexedDB 迁移，仅推进修订号
        targetVersion = 5;
      } else if (await this.migrateStashGroupsToIndexedDB()) {
        targetVersion = 5;
        await StorageAdapter.set(StorageKeys.IDB_MIGRATED_AT, Date.now());
      } else {
        // IndexedDB 不可用或迁移失败：本地数据修订停在 4，旧数据完整保留，下次启动自动重试
        targetVersion = 4;
      }
    }

    // 本地数据修订 6：修复历史恢复/撤销操作产生的双前缀重复条目，并清理无组记录的孤儿条目
    if (targetVersion >= 5 && currentVersion < 6) {
      if (await this.repairIndexedEntries()) {
        targetVersion = 6;
      } else {
        // 修复失败：本地数据修订停在 5，下次启动自动重试（修订 5 门控语义不受影响）
        targetVersion = 5;
      }
    }

    // 本地数据修订 7：配置、链接规则、自动备份与活动统计迁入 IndexedDB（阶段一 M2 全量）
    if (targetVersion >= 6 && currentVersion < 7) {
      const settingsMigrated = await this.migrateSettingsToIndexedDB();
      if (settingsMigrated) {
        targetVersion = 7;
      } else {
        // 迁移失败：本地数据修订停在 6，下次启动自动重试（收纳主库不受影响）
        targetVersion = 6;
      }
    }

    // 本地数据修订 8：WebDAV 同步元数据（阶段二 M3）：初始化本机时钟、回填实体同步字段、活跃度改为按 pageId
    if (targetVersion >= 7 && currentVersion < 8) {
      const optedOut = (await StorageAdapter.getChrome(StorageKeys.IDB_OPTOUT, false)) === true;
      if (optedOut) {
        // 已回退旧存储：同步仓储不启用，仅推进修订号
        targetVersion = 8;
      } else if (await this.prepareSyncMetadata()) {
        targetVersion = 8;
      } else {
        // 准备失败：本地数据修订停在 7，下次启动自动重试（阶段一数据源不受影响）
        targetVersion = 7;
      }
    }

    await StorageAdapter.setChrome(StorageKeys.SCHEMA_VERSION, targetVersion);
    console.info(`[MigrationManager] 数据架构迁移完成，当前本地数据修订: ${targetVersion}`);
    await this.cleanupLegacyStashData(targetVersion);
  }

  /**
   * 以默认配置为基础深度合并用户已有配置（本地数据修订 3、4 迁移共用）
   */
  static async _mergeUserConfig() {
    const existingConfig = await StorageAdapter.get(StorageKeys.USER_CONFIG, {});
    await StorageAdapter.set(StorageKeys.USER_CONFIG, StorageAdapter.mergeUserConfig(existingConfig));
  }

  /**
   * 本地数据修订 5 迁移：将 chrome.storage.local 中的旧版收纳组数组搬运至 IndexedDB 主库
   * 整个过程持有跨上下文写锁，与旧存储写入路径（同样持锁）互斥，杜绝漏拷。
   * @returns {Promise<boolean>} 是否迁移成功（无旧数据视为成功）
   */
  static async migrateStashGroupsToIndexedDB() {
    if (!IndexedStashRepository.isSupported()) {
      console.info('[MigrationManager] 当前环境不支持 IndexedDB，本地数据修订 5 主库迁移延后重试');
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
   * 本地数据修订 6 修复迁移：清理 IndexedDB 中的两类历史异常条目
   * 1. 孤儿条目：组记录缺失的收纳条目（历史版本创建组跨事务中断的产物）；
   * 2. 双前缀条目：entryId 形如 `grp::grp::tab_item_x`（历史恢复备份把已含组前缀的
   *    tab.id 再次拼接所致），与同组内单前缀条目重复，会让组内标签在界面上翻倍。
   * 操作幂等可重入：中断重跑不产生副作用，失败时版本停在 本地数据修订 5 下次重试。
   * @returns {Promise<boolean>}
   */
  static async repairIndexedEntries() {
    if (!IndexedStashRepository.isSupported()) {
      // 无主库（不支持 IndexedDB 或从未迁移）即无可修复数据，直接视为完成
      return true;
    }
    try {
      return await IndexedDBManager.withWriteLock(async () => {
        const [entryRecords, groupRecords] = await IndexedDBManager.runTransaction(
          [IDBStores.STASH_ENTRIES, IDBStores.STASH_GROUPS],
          'readonly',
          async (tx) => {
            const entries = await IndexedDBManager.requestToPromise(
              tx.objectStore(IDBStores.STASH_ENTRIES).getAll()
            );
            const groups = await IndexedDBManager.requestToPromise(
              tx.objectStore(IDBStores.STASH_GROUPS).getAll()
            );
            return [entries, groups];
          }
        );

        const groupIds = new Set(groupRecords.map((group) => group.groupId));
        const toDelete = [];
        const toWrite = [];

        for (const entry of entryRecords) {
          const prefix = `${entry.groupId}::`;
          // 孤儿条目：所属组不存在，去重判定会被其污染，直接清理
          if (!groupIds.has(entry.groupId)) {
            toDelete.push(entry.entryId);
            continue;
          }
          if (!entry.entryId.startsWith(prefix)) continue;

          // 双前缀条目：反复剥离组前缀得到规范 entryId
          let cleanKey = entry.entryId.slice(prefix.length);
          while (cleanKey.startsWith(prefix)) {
            cleanKey = cleanKey.slice(prefix.length);
          }
          const finalId = `${entry.groupId}::${cleanKey}`;
          if (finalId === entry.entryId) continue;

          const hasCanonical = entryRecords.some(
            (other) => other !== entry && other.entryId === finalId
          );
          if (!hasCanonical) {
            toWrite.push({ ...entry, entryId: finalId });
          }
          toDelete.push(entry.entryId);
        }

        if (toDelete.length === 0 && toWrite.length === 0) return true;

        await IndexedDBManager.runTransaction([IDBStores.STASH_ENTRIES], 'readwrite', async (tx) => {
          const store = tx.objectStore(IDBStores.STASH_ENTRIES);
          for (const entryId of toDelete) store.delete(entryId);
          for (const record of toWrite) store.put(record);
        });

        console.info(
          `[MigrationManager] 本地数据修订 6 修复完成：清理异常条目 ${toDelete.length} 条，规范化重写 ${toWrite.length} 条`
        );
        return true;
      });
    } catch (err) {
      console.warn('[MigrationManager] 本地数据修订 6 条目修复执行异常，将于下次启动重试:', err);
      return false;
    }
  }

  /**
   * 本地数据修订 7 迁移：将用户配置、域名跳转规则、自动备份与活动统计搬运至 IndexedDB
   * 写入使用无版本门控的直接仓储接口（此时 schema 仍为 6，StorageAdapter.set 仍指向 chrome.storage）。
   * 修订推进放在同一把写锁内，避免"已写主库但版本未切"窗口期把新写入打进旧存储。
   * @returns {Promise<boolean>}
   */
  static async migrateSettingsToIndexedDB() {
    const optedOut = (await StorageAdapter.getChrome(StorageKeys.IDB_OPTOUT, false)) === true;
    if (optedOut) {
      // 用户已显式回退：配置继续留在 chrome.storage，仅推进修订号
      return true;
    }
    if (!IndexedDBManager.isSupported()) {
      console.info('[MigrationManager] 当前环境不支持 IndexedDB，本地数据修订 7 配置迁移延后重试');
      return false;
    }
    try {
      return await IndexedDBManager.withWriteLock(async () => {
        const existingConfig = await StorageAdapter._getIdbValue(IDBStores.SETTINGS, StorageKeys.USER_CONFIG);
        const existingRules = await StorageAdapter._getIdbValue(IDBStores.SETTINGS, StorageKeys.LINK_RULES);
        const existingBackups = await StorageAdapter._getIdbValue(IDBStores.SETTINGS, StorageKeys.AUTO_BACKUPS);
        const existingStats = await StorageAdapter._getIdbValue(IDBStores.ACTIVITY_STATS, StorageKeys.ACTIVITY_STATS);

        // 幂等：主库已有记录则跳过，避免中断重跑用旧 chrome.storage 快照覆盖用户在主库中的新写入
        if (existingConfig === undefined) {
          const userConfig = StorageAdapter.mergeUserConfig(
            await StorageAdapter.getChrome(StorageKeys.USER_CONFIG, {})
          );
          await StorageAdapter._setIdbValue(IDBStores.SETTINGS, StorageKeys.USER_CONFIG, userConfig);
        }
        if (existingRules === undefined) {
          const linkRulesRaw = await StorageAdapter.getChrome(StorageKeys.LINK_RULES, {});
          const linkRules = linkRulesRaw && typeof linkRulesRaw === 'object' && !Array.isArray(linkRulesRaw)
            ? linkRulesRaw
            : {};
          await StorageAdapter._setIdbValue(IDBStores.SETTINGS, StorageKeys.LINK_RULES, linkRules);
        }
        if (existingBackups === undefined) {
          const backupsRaw = await StorageAdapter.getChrome(StorageKeys.AUTO_BACKUPS, []);
          await StorageAdapter._setIdbValue(
            IDBStores.SETTINGS,
            StorageKeys.AUTO_BACKUPS,
            Array.isArray(backupsRaw) ? backupsRaw : []
          );
        }
        if (existingStats === undefined) {
          const sessionStats = await StorageAdapter.getChrome(StorageKeys.ACTIVITY_STATS, null, 'session');
          const localStats = await StorageAdapter.getChrome(StorageKeys.ACTIVITY_STATS, {});
          const activityStats = (sessionStats && typeof sessionStats === 'object')
            ? sessionStats
            : (localStats && typeof localStats === 'object' ? localStats : {});
          await StorageAdapter._setIdbValue(IDBStores.ACTIVITY_STATS, StorageKeys.ACTIVITY_STATS, activityStats);
        }

        const storedConfig = await StorageAdapter._getIdbValue(IDBStores.SETTINGS, StorageKeys.USER_CONFIG);
        const storedRules = await StorageAdapter._getIdbValue(IDBStores.SETTINGS, StorageKeys.LINK_RULES);
        if (storedConfig === undefined || storedRules === undefined) {
          console.warn('[MigrationManager] 本地数据修订 7 配置迁移完整性校验未通过，将于下次启动重试');
          return false;
        }

        await StorageAdapter.setChrome(StorageKeys.IDB_SETTINGS_MIGRATED_AT, Date.now());
        // 修订推进必须在同一把写锁内完成，避免并发配置写入落到旧存储后被主库覆盖
        await StorageAdapter.setChrome(StorageKeys.SCHEMA_VERSION, 7);
        console.info('[MigrationManager] 已将配置、链接规则、自动备份与活动统计迁移至 IndexedDB 主库（旧数据保留 30 天）');
        return true;
      });
    } catch (err) {
      console.warn('[MigrationManager] 本地数据修订 7 配置迁移执行异常，将于下次启动重试:', err);
      return false;
    }
  }

  /**
   * 本地数据修订 8 迁移：为 WebDAV 同步准备本地元数据（幂等、可中断重跑）
   * 1. 初始化本机同步时钟（deviceId / sequence / lamport / datasetId）；
   * 2. 为已有页面 / 收纳组 / 收纳条目回填 updatedAt / revision / originDeviceId / fieldRevs；
   * 3. 活跃度从 { [tabId]: ... } 转换为 { [pageId]: ... }，无法映射的旧 tabId 记录直接丢弃。
   * 全程持跨上下文写锁，失败时版本停在 本地数据修订 7 下次重试。
   * @returns {Promise<boolean>}
   */
  static async prepareSyncMetadata() {
    if (!IndexedDBManager.isSupported()) {
      console.info('[MigrationManager] 当前环境不支持 IndexedDB，本地数据修订 8 同步元数据准备延后重试');
      return false;
    }
    try {
      return await IndexedDBManager.withWriteLock(async () => {
        // 1. 初始化本机时钟（幂等：已有则跳过）
        await IndexedDBManager.runTransaction([IDBStores.SYNC_META], 'readwrite', async (tx) => {
          const store = tx.objectStore(IDBStores.SYNC_META);
          const existing = await IndexedDBManager.requestToPromise(store.get(SYNC_CLOCK_KEY));
          if (existing?.value) return;
          const rand = Math.random().toString(36).slice(2, 10);
          const now = Date.now();
          store.put({
            key: SYNC_CLOCK_KEY,
            value: {
              deviceId: `dev_${now.toString(36)}_${rand}`,
              sequence: 0,
              lamport: 0,
              seenLamport: 0,
              datasetId: `ds_${now.toString(36)}_${rand}`
            },
            updatedAt: now
          });
        });

        // 2. 回填实体同步元数据（仅补缺失字段，天然幂等）
        await IndexedDBManager.runTransaction(
          [IDBStores.PAGES, IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES],
          'readwrite',
          async (tx) => {
            const now = Date.now();
            for (const storeName of [IDBStores.PAGES, IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES]) {
              const store = tx.objectStore(storeName);
              const records = await IndexedDBManager.requestToPromise(store.getAll());
              for (const record of records || []) {
                let changed = false;
                if (typeof record.updatedAt !== 'number') {
                  record.updatedAt = now;
                  changed = true;
                }
                if (typeof record.revision !== 'number') {
                  record.revision = 0;
                  changed = true;
                }
                if (typeof record.originDeviceId !== 'string') {
                  record.originDeviceId = '';
                  changed = true;
                }
                if (!record.fieldRevs || typeof record.fieldRevs !== 'object') {
                  record.fieldRevs = {};
                  changed = true;
                }
                if (changed) store.put(record);
              }
            }
          }
        );

        // 3. 活跃度 tabId → pageId 转换（旧 tabId 无法映射 URL，直接丢弃）
        const statsRecord = await IndexedDBManager.runTransaction(
          [IDBStores.ACTIVITY_STATS],
          'readonly',
          async (tx) => {
            return await IndexedDBManager.requestToPromise(
              tx.objectStore(IDBStores.ACTIVITY_STATS).get(StorageKeys.ACTIVITY_STATS)
            );
          }
        );
        const stats = statsRecord?.value;
        if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
          const converted = {};
          let dropped = 0;
          for (const [key, value] of Object.entries(stats)) {
            if (key === 'fieldRevs') continue;
            if (/^page_/.test(key)) {
              converted[key] = value;
            } else {
              dropped += 1;
            }
          }
          if (dropped > 0 || Object.keys(converted).length !== Object.keys(stats).length) {
            await IndexedDBManager.runTransaction([IDBStores.ACTIVITY_STATS], 'readwrite', async (tx) => {
              tx.objectStore(IDBStores.ACTIVITY_STATS).put({
                key: StorageKeys.ACTIVITY_STATS,
                value: converted,
                updatedAt: Date.now()
              });
            });
            console.info(`[MigrationManager] 本地数据修订 8 已将活跃度转换为按 pageId 存储（丢弃无法映射的旧记录 ${dropped} 条）`);
          }
        }

        const clockCheck = await IndexedDBManager.runTransaction([IDBStores.SYNC_META], 'readonly', async (tx) => {
          return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.SYNC_META).get(SYNC_CLOCK_KEY));
        });
        if (!clockCheck?.value?.deviceId) {
          console.warn('[MigrationManager] 本地数据修订 8 同步元数据完整性校验未通过，将于下次启动重试');
          return false;
        }
        console.info('[MigrationManager] 本地数据修订 8 同步元数据准备完成（本机时钟、实体字段与活跃度 pageId 化）');
        return true;
      });
    } catch (err) {
      console.warn('[MigrationManager] 本地数据修订 8 同步元数据准备异常，将于下次启动重试:', err);
      return false;
    }
  }

  /**
   * 清理超过保留期的旧版收纳数组（迁移成功 30 天后执行）
   * @param {number} currentVersion - 当前生效的本地数据修订号
   */
  static async cleanupLegacyStashData(currentVersion) {
    const retentionMs = LEGACY_STASH_RETENTION_DAYS * 86400000;
    if (Number(currentVersion) >= 5) {
      const migratedAt = await StorageAdapter.getChrome(StorageKeys.IDB_MIGRATED_AT, 0);
      if (migratedAt && Date.now() - migratedAt >= retentionMs) {
        const legacyGroups = await StorageAdapter.getChrome(StorageKeys.STASH_GROUPS, []);
        if (Array.isArray(legacyGroups) && legacyGroups.length > 0) {
          await StorageAdapter.setChrome(
            StorageKeys.STASH_REV,
            `${Date.now()}_legacy_cleanup_${Math.random().toString(36).slice(2, 7)}`
          );
          await StorageAdapter.setChrome(StorageKeys.STASH_GROUPS, []);
          console.info('[MigrationManager] 旧版 chrome.storage.local 收纳数据已超过保留期，完成清理');
        }
      }
    }

    if (Number(currentVersion) >= 7) {
      const settingsMigratedAt = await StorageAdapter.getChrome(StorageKeys.IDB_SETTINGS_MIGRATED_AT, 0);
      if (settingsMigratedAt && Date.now() - settingsMigratedAt >= retentionMs) {
        await StorageAdapter.setChrome(StorageKeys.USER_CONFIG, {});
        await StorageAdapter.setChrome(StorageKeys.LINK_RULES, {});
        await StorageAdapter.setChrome(StorageKeys.AUTO_BACKUPS, []);
        await StorageAdapter.setChrome(StorageKeys.ACTIVITY_STATS, {});
        console.info('[MigrationManager] 旧版 chrome.storage.local 配置/规则/备份/活跃度已超过保留期，完成清理');
      }
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
      // 回退的"读主库 → 写旧存储 → 置回退标记"整体持跨上下文写锁：
      // 防止回退期间并发 createGroup 向 IndexedDB 写入新组后被滞留在不再被读取的主库中
      return await IndexedDBManager.withWriteLock(async () => {
        const groups = await IndexedStashRepository.getAllGroups();
        const ok = await StorageAdapter.setChrome(StorageKeys.STASH_GROUPS, groups);
        if (!ok) {
          return { success: false, error: '写回 chrome.storage.local 失败' };
        }

        // 同步导回 本地数据修订 7 配置主库，保证回退后 chrome.storage 仍是完整数据源
        const idbConfig = await StorageAdapter._getIdbValue(IDBStores.SETTINGS, StorageKeys.USER_CONFIG);
        const idbRules = await StorageAdapter._getIdbValue(IDBStores.SETTINGS, StorageKeys.LINK_RULES);
        const idbBackups = await StorageAdapter._getIdbValue(IDBStores.SETTINGS, StorageKeys.AUTO_BACKUPS);
        const idbStats = await StorageAdapter._getIdbValue(IDBStores.ACTIVITY_STATS, StorageKeys.ACTIVITY_STATS);
        if (idbConfig !== undefined) await StorageAdapter.setChrome(StorageKeys.USER_CONFIG, idbConfig);
        if (idbRules !== undefined) await StorageAdapter.setChrome(StorageKeys.LINK_RULES, idbRules);
        if (idbBackups !== undefined) await StorageAdapter.setChrome(StorageKeys.AUTO_BACKUPS, idbBackups);
        if (idbStats !== undefined) await StorageAdapter.setChrome(StorageKeys.ACTIVITY_STATS, idbStats);

        await StorageAdapter.setChrome(StorageKeys.IDB_OPTOUT, true);
        await StorageAdapter.setChrome(StorageKeys.IDB_MIGRATED_AT, 0);
        await StorageAdapter.setChrome(StorageKeys.IDB_SETTINGS_MIGRATED_AT, 0);
        // 广播变更，让打开中的选项页立即切换到旧存储数据源
        await StorageAdapter.setChrome(
          StorageKeys.STASH_REV,
          `${Date.now()}_rollback_${Math.random().toString(36).slice(2, 7)}`
        );
        console.info(`[MigrationManager] 已从 IndexedDB 回退至 chrome.storage.local 旧存储（共 ${groups.length} 组）`);
        return { success: true, groupCount: groups.length };
      });
    } catch (err) {
      console.warn('[MigrationManager] IndexedDB 回退执行异常:', err);
      return { success: false, error: err.message };
    }
  }
}
