/**
 * @file snapshot.js
 * @description generation 快照的生成与应用（watermark 之后才重放操作）
 * @encoding UTF-8
 */

import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';
import { StorageKeys } from '../../constants/storage-keys.js';
import { SYNC_CLOCK_KEY, WEBDAV_FORMAT_REVISION, SyncEntityTypes, isValidLinkRule, pickSyncableConfig } from './sync-constants.js';
import { sha256Hex } from './crypto-util.js';
import { AccountConfigSync } from './account-config-sync.js';
import { DeviceEventLog } from './device-events.js';
import { IndexedStashRepository } from '../stash/indexed-stash-repo.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { SyncMerge } from './merge.js';

/** 本地快照缓存保留份数 */
const LOCAL_SNAPSHOT_KEEP = 2;

export class SyncSnapshot {
  /**
   * 导出当前可同步实体为快照对象（不含凭据与本地自动备份）
   * @returns {Promise<object>}
   */
  static async buildPayload() {
    return await IndexedDBManager.runTransaction(
      [
        IDBStores.PAGES,
        IDBStores.STASH_GROUPS,
        IDBStores.STASH_ENTRIES,
        IDBStores.SETTINGS,
        IDBStores.ACTIVITY_STATS,
        IDBStores.DEVICE_EVENTS,
        IDBStores.TOMBSTONES,
        IDBStores.SYNC_META
      ],
      'readonly',
      async (tx) => {
        const pages = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.PAGES).getAll());
        const groups = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.STASH_GROUPS).getAll());
        const entries = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.STASH_ENTRIES).getAll());
        const settingsAll = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.SETTINGS).getAll());
        const activityRecords = await IndexedDBManager.requestToPromise(
          tx.objectStore(IDBStores.ACTIVITY_STATS).getAll()
        );
        const activityStats = {};
        for (const record of activityRecords || []) {
          if (!record?.key) continue;
          if (record.key === StorageKeys.ACTIVITY_STATS && record.value && typeof record.value === 'object') {
            Object.assign(activityStats, record.value);
            continue;
          }
          if (/^page_/.test(record.key) && record.value && typeof record.value === 'object') {
            activityStats[record.key] = record.value;
          }
        }
        const events = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.DEVICE_EVENTS).getAll());
        const tombs = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.TOMBSTONES).getAll());
        const clock = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.SYNC_META).get(SYNC_CLOCK_KEY));

        // 快照只携带可同步配置：凭据、自动备份与设备本地偏好（AI 桥接开关、主页与外部联想同意）绝不外传
        const settings = {};
        for (const record of settingsAll || []) {
          if (record.key === StorageKeys.USER_CONFIG && record.value && typeof record.value === 'object') {
            settings[record.key] = pickSyncableConfig(record.value);
          } else if (record.key === StorageKeys.LINK_RULES) {
            settings[record.key] = record.value;
          }
        }

        const liveTombs = (tombs || []).filter((item) => Number(item.expiresAt) > Date.now());
        const watermarks = {};
        if (clock?.value?.deviceId) {
          watermarks[clock.value.deviceId] = Number(clock.value.sequence) || 0;
        }

        return {
          formatVersion: WEBDAV_FORMAT_REVISION,
          createdAt: Date.now(),
          watermarks,
          pages: pages || [],
          stashGroups: groups || [],
          stashEntries: entries || [],
          settings,
          activityStats,
          deviceEvents: events || [],
          tombstones: liveTombs
        };
      }
    );
  }

  /**
   * 序列化并计算 sha256
   * @param {object} payload
   */
  static async serialize(payload) {
    const body = JSON.stringify(payload);
    const sha256 = await sha256Hex(body);
    return { body, sha256 };
  }

  /**
   * 用快照覆盖本地可同步实体（调用方须持写锁）。凭据与自动备份保留。
   * @param {object} payload
   * @param {{ merge?: boolean }} [options] - merge=true 时不清空本地仓储，
   *   仅按快照墓碑执行删除，保护尚未同步的本地实体（新设备配对 / 离线期间创建的数据）
   */
  static async applyPayload(payload, { merge = false } = {}) {
    if (!payload || typeof payload !== 'object') throw new Error('快照载荷无效');
    await IndexedDBManager.runTransaction(
      [
        IDBStores.PAGES,
        IDBStores.STASH_GROUPS,
        IDBStores.STASH_ENTRIES,
        IDBStores.SETTINGS,
        IDBStores.ACTIVITY_STATS,
        IDBStores.DEVICE_EVENTS,
        IDBStores.TOMBSTONES,
        IDBStores.SYNC_META
      ],
      'readwrite',
      async (tx) => {
        if (!merge) {
          tx.objectStore(IDBStores.PAGES).clear();
          tx.objectStore(IDBStores.STASH_GROUPS).clear();
          tx.objectStore(IDBStores.STASH_ENTRIES).clear();
          tx.objectStore(IDBStores.DEVICE_EVENTS).clear();
          tx.objectStore(IDBStores.TOMBSTONES).clear();
          tx.objectStore(IDBStores.ACTIVITY_STATS).clear();
        }

        // 合并模式：快照可能由尚未看到本机最新修改的设备生成。
        // 逐字段按版本取胜，本机墓碑期内已删除的实体不得被快照复活。
        // （本机自己的操作已在 operationLogs 中，补放阶段会被跳过，不能指望它把值改回来）
        const localTombs = new Set();
        if (merge) {
          const tombs = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.TOMBSTONES).getAll());
          for (const tomb of tombs || []) {
            if (Number(tomb?.expiresAt) > Date.now()) localTombs.add(tomb.tombstoneId);
          }
        }
        const putEntity = async (storeName, entityType, record, id) => {
          const store = tx.objectStore(storeName);
          if (!merge) {
            store.put(record);
            return;
          }
          if (localTombs.has(`${entityType}::${id}`)) return;
          const local = await IndexedDBManager.requestToPromise(store.get(id));
          store.put(this._mergeRecord(local, record));
        };

        for (const page of payload.pages || []) {
          if (page?.pageId) await putEntity(IDBStores.PAGES, SyncEntityTypes.PAGE, page, page.pageId);
        }
        for (const group of payload.stashGroups || []) {
          if (group?.groupId) await putEntity(IDBStores.STASH_GROUPS, SyncEntityTypes.STASH_GROUP, group, group.groupId);
        }
        for (const entry of payload.stashEntries || []) {
          if (entry?.entryId) await putEntity(IDBStores.STASH_ENTRIES, SyncEntityTypes.STASH_ENTRY, entry, entry.entryId);
        }
        for (const event of payload.deviceEvents || []) {
          if (event?.eventId) tx.objectStore(IDBStores.DEVICE_EVENTS).put(event);
        }
        for (const tomb of payload.tombstones || []) {
          if (!tomb?.tombstoneId) continue;
          tx.objectStore(IDBStores.TOMBSTONES).put(tomb);
          if (merge && Number(tomb.expiresAt) > Date.now()) {
            // 合并模式下按墓碑执行删除（替代清库语义），30 天内的删除不得被本地旧副本复活
            if (tomb.entityType === SyncEntityTypes.PAGE) {
              tx.objectStore(IDBStores.PAGES).delete(tomb.entityId);
            } else if (tomb.entityType === SyncEntityTypes.STASH_GROUP) {
              tx.objectStore(IDBStores.STASH_GROUPS).delete(tomb.entityId);
            } else if (tomb.entityType === SyncEntityTypes.STASH_ENTRY) {
              tx.objectStore(IDBStores.STASH_ENTRIES).delete(tomb.entityId);
            }
          }
        }

        const settingsStore = tx.objectStore(IDBStores.SETTINGS);
        const incomingSettings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
        const incomingConfig = incomingSettings[StorageKeys.USER_CONFIG];
        if (incomingConfig && typeof incomingConfig === 'object') {
          // 只把可同步部分合并进本机配置，设备本地偏好保持不变（快照可被远端伪造，不能整体覆盖）
          const record = await IndexedDBManager.requestToPromise(settingsStore.get(StorageKeys.USER_CONFIG));
          const local = record?.value && typeof record.value === 'object' ? record.value : {};
          const synced = pickSyncableConfig(incomingConfig);
          const localRevs = local.fieldRevs && typeof local.fieldRevs === 'object' ? local.fieldRevs : {};
          const incomingRevs = synced.fieldRevs || {};
          const next = { ...local };
          const nextRevs = { ...localRevs };
          for (const [key, value] of Object.entries(synced)) {
            if (key === 'fieldRevs') continue;
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              const nested = { ...(local[key] && typeof local[key] === 'object' ? local[key] : {}) };
              for (const [sub, subValue] of Object.entries(value)) {
                const path = `${key}.${sub}`;
                if (merge && !this._incomingWins(localRevs[path], incomingRevs[path])) continue;
                nested[sub] = subValue;
                if (incomingRevs[path]) nextRevs[path] = incomingRevs[path];
              }
              next[key] = nested;
            } else {
              if (merge && !this._incomingWins(localRevs[key], incomingRevs[key])) continue;
              next[key] = value;
              if (incomingRevs[key]) nextRevs[key] = incomingRevs[key];
            }
          }
          next.fieldRevs = nextRevs;
          settingsStore.put({ key: StorageKeys.USER_CONFIG, value: next, updatedAt: Date.now() });
        }
        const incomingRules = incomingSettings[StorageKeys.LINK_RULES];
        if (incomingRules && typeof incomingRules === 'object') {
          const incomingRuleRevs = incomingRules.fieldRevs && typeof incomingRules.fieldRevs === 'object'
            ? incomingRules.fieldRevs
            : {};
          const record = merge
            ? await IndexedDBManager.requestToPromise(settingsStore.get(StorageKeys.LINK_RULES))
            : null;
          const localRules = record?.value && typeof record.value === 'object' ? record.value : {};
          const localRuleRevs = localRules.fieldRevs && typeof localRules.fieldRevs === 'object' ? localRules.fieldRevs : {};
          const safeRules = merge ? { ...localRules, fieldRevs: { ...localRuleRevs } } : { fieldRevs: { ...incomingRuleRevs } };
          for (const [domain, mode] of Object.entries(incomingRules)) {
            if (domain === 'fieldRevs' || !isValidLinkRule(domain, mode)) continue;
            const key = domain.toLowerCase();
            if (merge && !this._incomingWins(localRuleRevs[key], incomingRuleRevs[domain])) continue;
            safeRules[key] = mode;
            if (merge && incomingRuleRevs[domain]) safeRules.fieldRevs[key] = incomingRuleRevs[domain];
          }
          settingsStore.put({ key: StorageKeys.LINK_RULES, value: safeRules, updatedAt: Date.now() });
        }

        // 快照内实体的版本必须计入本机已见 lamport：仅靠快照入网的设备（watermark 之内的操作不再补放）
        // 若从很小的 lamport 起步，其后续修改会在所有老设备上被判为"更旧"而静默丢弃
        const maxLamport = this._maxLamport(payload);
        if (maxLamport > 0) {
          const meta = tx.objectStore(IDBStores.SYNC_META);
          const clockRecord = await IndexedDBManager.requestToPromise(meta.get(SYNC_CLOCK_KEY));
          if (clockRecord?.value && (Number(clockRecord.value.seenLamport) || 0) < maxLamport) {
            clockRecord.value.seenLamport = maxLamport;
            meta.put({ key: SYNC_CLOCK_KEY, value: clockRecord.value, updatedAt: Date.now() });
          }
        }

        const activityStore = tx.objectStore(IDBStores.ACTIVITY_STATS);
        // 快照应用按 pageId 分记录写入，并清掉历史聚合键
        activityStore.delete(StorageKeys.ACTIVITY_STATS);
        const incomingActivity = payload.activityStats && typeof payload.activityStats === 'object'
          ? payload.activityStats
          : {};
        for (const [pageId, pageValue] of Object.entries(incomingActivity)) {
          if (!/^page_/.test(pageId) || !pageValue || typeof pageValue !== 'object') continue;
          const incoming = {
            url: typeof pageValue.url === 'string' ? pageValue.url : '',
            lastActivated: Number(pageValue.lastActivated) || 0,
            activationTimestamps: Array.isArray(pageValue.activationTimestamps)
              ? pageValue.activationTimestamps.filter((ts) => Number.isFinite(ts))
              : []
          };
          // 合并模式与操作补放同一口径：时间戳并集、lastActivated 取最大
          const existing = merge ? await IndexedDBManager.requestToPromise(activityStore.get(pageId)) : null;
          activityStore.put({
            key: pageId,
            value: existing?.value ? SyncMerge._mergeActivityRecord(existing.value, incoming) : incoming,
            updatedAt: Date.now()
          });
        }
        // 合并模式下本地与快照条目并存，组计数以实际条目为准
        await IndexedStashRepository.recountGroupsInTx(tx);
      }
    );
    await StorageAdapter.bumpStashRevision();
    for (const event of payload.deviceEvents || []) {
      DeviceEventLog.appendRuntimeLog(event).catch(() => {});
    }
    AccountConfigSync.scheduleMirror();
  }

  /**
   * 远端字段版本是否胜过本地（无远端版本时仅在本地也无版本时采纳，保持旧数据兼容）
   * @param {{ lamport?: number, deviceId?: string } | undefined} localRev
   * @param {{ lamport?: number, deviceId?: string } | undefined} incomingRev
   * @returns {boolean}
   */
  static _incomingWins(localRev, incomingRev) {
    if (!incomingRev) return !localRev;
    if (!localRev) return true;
    return SyncMerge.preferredRev(localRev, incomingRev) === incomingRev;
  }

  /**
   * 字段级合并一条实体记录：带版本的字段按版本取胜，无版本字段（派生计数、本地元数据）保留本地
   * @param {object | undefined} local
   * @param {object} incoming
   * @returns {object}
   */
  static _mergeRecord(local, incoming) {
    if (!local) return incoming;
    const localRevs = local.fieldRevs && typeof local.fieldRevs === 'object' ? local.fieldRevs : {};
    const incomingRevs = incoming.fieldRevs && typeof incoming.fieldRevs === 'object' ? incoming.fieldRevs : {};
    const merged = { ...incoming, ...local };
    const revs = { ...localRevs };
    for (const [field, rev] of Object.entries(incomingRevs)) {
      if (!this._incomingWins(localRevs[field], rev)) continue;
      merged[field] = incoming[field];
      revs[field] = rev;
    }
    merged.fieldRevs = revs;
    return merged;
  }

  /**
   * 快照内出现过的最大 lamport（实体修订号与各字段版本）
   * @param {object} payload
   * @returns {number}
   */
  static _maxLamport(payload) {
    let max = 0;
    const visitRevs = (revs) => {
      if (!revs || typeof revs !== 'object') return;
      for (const rev of Object.values(revs)) max = Math.max(max, Number(rev?.lamport) || 0);
    };
    for (const list of [payload.pages, payload.stashGroups, payload.stashEntries]) {
      for (const record of Array.isArray(list) ? list : []) {
        max = Math.max(max, Number(record?.revision) || 0);
        visitRevs(record?.fieldRevs);
      }
    }
    for (const value of Object.values(payload.settings && typeof payload.settings === 'object' ? payload.settings : {})) {
      visitRevs(value?.fieldRevs);
    }
    return max;
  }

  /**
   * 缓存一份已校验的快照到本地 SNAPSHOTS 仓储（供损坏回退）
   * @param {string} snapshotId
   * @param {object} payload
   * @param {string} [sha256]
   */
  static async cacheLocal(snapshotId, payload, sha256 = '') {
    if (!snapshotId || !payload || typeof payload !== 'object') return;
    const match = String(snapshotId).match(/(\d+)/);
    const generation = match ? Number(match[1]) : 0;
    await IndexedDBManager.runTransaction([IDBStores.SNAPSHOTS], 'readwrite', async (tx) => {
      const store = tx.objectStore(IDBStores.SNAPSHOTS);
      store.put({
        snapshotId,
        generation,
        createdAt: Number(payload.createdAt) || Date.now(),
        sha256: sha256 || '',
        payload
      });
      // 每份缓存都是完整载荷：只保留最新的若干份（当前 + 上一份即可满足损坏回退）
      const all = await IndexedDBManager.requestToPromise(store.getAll());
      const stale = (all || [])
        .filter((item) => item.snapshotId !== snapshotId)
        .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
        .slice(LOCAL_SNAPSHOT_KEEP - 1);
      for (const item of stale) store.delete(item.snapshotId);
    });
  }

  /**
   * 读取本地缓存的快照
   * @param {string} snapshotId
   * @returns {Promise<{ snapshotId: string, sha256?: string, payload?: object, createdAt?: number } | null>}
   */
  static async getLocal(snapshotId) {
    if (!snapshotId) return null;
    return await IndexedDBManager.runTransaction([IDBStores.SNAPSHOTS], 'readonly', async (tx) => {
      return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.SNAPSHOTS).get(snapshotId)) || null;
    });
  }

  /**
   * 列出本地缓存快照（按 createdAt 降序）
   * @returns {Promise<object[]>}
   */
  static async listLocal() {
    return await IndexedDBManager.runTransaction([IDBStores.SNAPSHOTS], 'readonly', async (tx) => {
      const all = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.SNAPSHOTS).getAll());
      return (all || []).sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    });
  }

  /**
   * 过滤出快照 watermark 之后的操作
   * @param {object[]} operations
   * @param {Record<string, number>} watermarks
   */
  static filterAfterWatermark(operations, watermarks) {
    const marks = watermarks && typeof watermarks === 'object' ? watermarks : {};
    return (operations || []).filter((op) => {
      const seen = Number(marks[op.deviceId]) || 0;
      return Number(op.sequence) > seen;
    });
  }
}
