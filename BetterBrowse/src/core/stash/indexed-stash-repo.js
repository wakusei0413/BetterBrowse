/**
 * @file indexed-stash-repo.js
 * @description 基于 IndexedDB 的收纳仓储实现（页面实体 + 收纳记录两层模型，支持索引去重、分页与关键字检索）
 *
 * ⚠️ 并发契约：本类的全部"写方法"（createGroup / updateGroup / deleteGroup / deleteTabItem /
 * clearAll / deduplicateGroups / importGroups）均不自行获取跨上下文写锁，
 * 必须由调用方（LocalStashRepository 门面或 MigrationManager 迁移流程）在持有
 * IndexedDBManager.withWriteLock 的事务临界区内调用；读方法可随时并发调用。
 * @encoding UTF-8
 */

import {
  IndexedDBManager,
  IDBStores,
  STASH_GROUP_SORT_INDEX,
  STASH_ENTRY_POSITION_INDEX
} from '../storage/indexed-db.js';
import { SyncOutbox } from '../sync/outbox.js';
import { SyncEntityTypes, SyncOps, TOMBSTONE_TTL_MS } from '../sync/sync-constants.js';

/** 单批次写入的最大记录数（避免单次大事务被 Service Worker 休眠打断） */
const WRITE_BATCH_SIZE = 500;

/** 单次有界搜索最多扫描的条目数 */
const DEFAULT_SEARCH_SCAN_LIMIT = 2000;

/** 复合索引范围使用的最大字符串哨兵 */
const MAX_KEY_TEXT = '\uffff';

export class IndexedStashRepository {
  /**
   * 当前环境是否可用 IndexedDB 仓储
   * @returns {boolean}
   */
  static isSupported() {
    return IndexedDBManager.isSupported();
  }

  /**
   * 计算 URL 指纹作为页面实体主键（FNV-1a 双种子 64 位十六进制，碰撞概率可忽略）
   * @param {string} url
   * @returns {string}
   */
  static computePageId(url) {
    const normalized = String(url || '').trim();
    let hashA = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
      hashA ^= normalized.charCodeAt(i);
      hashA = Math.imul(hashA, 0x01000193) >>> 0;
    }
    let hashB = 0x9747b28c;
    for (let i = normalized.length - 1; i >= 0; i--) {
      hashB ^= normalized.charCodeAt(i);
      hashB = Math.imul(hashB, 0x85ebca6b) >>> 0;
    }
    return `page_${hashA.toString(16).padStart(8, '0')}${hashB.toString(16).padStart(8, '0')}`;
  }

  /**
   * 提取 URL 所属域名（用于页面实体 domain 索引）
   * @param {string} url
   * @returns {string}
   */
  static extractDomain(url) {
    try {
      return new URL(url).hostname || '';
    } catch {
      return '';
    }
  }

  /** 将游标键编码为可跨消息边界传输的字符串 */
  static _encodeCursor(value) {
    if (value === undefined || value === null) return null;
    return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
  }

  /** 解析游标字符串；非法游标按未提供处理 */
  static _decodeCursor(value) {
    if (!value || typeof value !== 'string') return null;
    try {
      return JSON.parse(decodeURIComponent(escape(atob(value))));
    } catch {
      return null;
    }
  }

  /** 构造指定组在组内位置复合索引上的完整范围 */
  static _groupEntryRange(groupId, lowerKey = null, lowerOpen = false) {
    const lower = Array.isArray(lowerKey) ? lowerKey : [groupId, 0, ''];
    return IDBKeyRange.bound(lower, [groupId, Number.MAX_SAFE_INTEGER, MAX_KEY_TEXT], lowerOpen, false);
  }

  /** 将组记录压成摘要，派生字段只读组记录，不扫描条目仓储 */
  static _toGroupSummary(record) {
    return {
      id: record.groupId,
      createdAt: record.createdAt,
      title: typeof record.title === 'string' ? record.title : '',
      color: typeof record.color === 'string' ? record.color : '',
      locked: Boolean(record.locked),
      starred: Boolean(record.starred),
      archived: Boolean(record.archived),
      itemCount: Math.max(0, Number(record.itemCount) || 0)
    };
  }

  /**
   * 生成默认组标题（与旧版 chrome.storage 仓储格式保持一致）
   * @param {number} timestamp
   * @param {number} count
   * @returns {string}
   */
  static _formatDefaultTitle(timestamp, count) {
    const dateStr = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(timestamp));
    return `${dateStr} 收纳 (${count} 个标签页)`;
  }

  /**
   * 将三层仓储记录组装为旧版结构（保持调用方兼容：组内嵌 tabs 数组）
   * @param {any[]} groupRecords - stashGroups 记录
   * @param {any[]} entryRecords - stashEntries 记录
   * @param {any[]} pageRecords - pages 记录
   * @returns {any[]}
   */
  static _composeGroups(groupRecords, entryRecords, pageRecords) {
    const pageById = new Map(pageRecords.map((page) => [page.pageId, page]));
    const entriesByGroup = new Map();
    for (const entry of entryRecords) {
      if (!entriesByGroup.has(entry.groupId)) entriesByGroup.set(entry.groupId, []);
      entriesByGroup.get(entry.groupId).push(entry);
    }
    // 组内条目按写入顺序（position）稳定还原
    for (const entryList of entriesByGroup.values()) {
      entryList.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }

    return groupRecords
      .map((record) => ({
        id: record.groupId,
        createdAt: record.createdAt,
        title: typeof record.title === 'string' ? record.title : '',
        color: typeof record.color === 'string' ? record.color : '',
        locked: Boolean(record.locked),
        starred: Boolean(record.starred),
        archived: Boolean(record.archived),
        tabs: (entriesByGroup.get(record.groupId) || []).map((entry) => {
          const page = pageById.get(entry.pageId);
          return {
            id: entry.entryId,
            url: page?.url || '',
            title: page?.title || page?.url || '无标题页面',
            favIconUrl: page?.favIconUrl || '',
            pinned: Boolean(entry.pinned),
            archived: Boolean(entry.archived)
          };
        })
      }))
      .sort((a, b) => {
        // 星标组优先置顶，其余按时间倒序（与旧版 getAllGroups 完全一致）
        if (a.starred && !b.starred) return -1;
        if (!a.starred && b.starred) return 1;
        return b.createdAt - a.createdAt;
      });
  }

  /**
   * 将条目与页面实体组装为列表行
   * @param {any} entry
   * @param {any} [page]
   * @returns {{ id: string, url: string, title: string, favIconUrl: string, pinned: boolean }}
   */
  static _toTabItem(entry, page) {
    return {
      id: entry.entryId,
      url: page?.url || '',
      title: page?.title || page?.url || '无标题页面',
      favIconUrl: page?.favIconUrl || '',
      pinned: Boolean(entry.pinned)
    };
  }

  /**
   * 在同一事务内并行读取指定 pageId 的页面实体
   * @param {IDBTransaction} tx
   * @param {Iterable<string>} pageIds
   * @returns {Promise<Map<string, any>>}
   */
  static async _loadPagesById(tx, pageIds) {
    const pagesStore = tx.objectStore(IDBStores.PAGES);
    const uniqueIds = [...new Set([...pageIds].filter(Boolean))];
    const pageById = new Map();
    await Promise.all(
      uniqueIds.map(async (pageId) => {
        const page = await IndexedDBManager.requestToPromise(pagesStore.get(pageId));
        if (page) pageById.set(pageId, page);
      })
    );
    return pageById;
  }

  /**
   * 游标分页读取收纳组摘要；只扫描组记录，previewLimit>0 时仅游标读取每组前 N 条。
   * @param {{ cursor?: string | null, limit?: number, previewLimit?: number }} [options]
   * @returns {Promise<{ items: any[], nextCursor: string | null, hasMore: boolean }>} 
   */
  static async listGroupSummariesPage({ cursor = null, limit = 100, previewLimit = 0, createdAtFrom = null, createdAtTo = null } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const safePreview = Math.max(0, Math.min(25, Math.floor(Number(previewLimit) || 0)));
    const minCreated = createdAtFrom == null || createdAtFrom === '' ? null : Number(createdAtFrom);
    const maxCreated = createdAtTo == null || createdAtTo === '' ? null : Number(createdAtTo);
    const minBound = Number.isFinite(minCreated) ? minCreated : null;
    const maxBound = Number.isFinite(maxCreated) ? maxCreated : null;
    const decodedCursor = this._decodeCursor(cursor);

    const allGroups = await IndexedDBManager.runTransaction([IDBStores.STASH_GROUPS], 'readonly', async (tx) => {
      return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.STASH_GROUPS).getAll());
    }) || [];
    if (!Array.isArray(allGroups)) {
      throw new Error(`收纳组摘要读取结果异常: ${typeof allGroups}`);
    }
    const sorted = [...allGroups].sort((a, b) => {
      const starDiff = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      if (starDiff) return starDiff;
      const timeDiff = (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
      if (timeDiff) return timeDiff;
      return String(a.groupId || '').localeCompare(String(b.groupId || ''));
    }).filter((group) => {
      const createdAt = Number(group.createdAt) || 0;
        if (minBound != null && createdAt < minBound) return false;
        if (maxBound != null && createdAt > maxBound) return false;

      return true;
    });
    let start = 0;
    if (Array.isArray(decodedCursor) && decodedCursor[0]) {
      const index = sorted.findIndex((group) => group.groupId === decodedCursor[0]);
      start = index >= 0 ? index + 1 : 0;
    }
    const sliced = sorted.slice(start, start + safeLimit);
    const hasMore = start + sliced.length < sorted.length;
    const records = sliced.map((record) => ({ record, key: [record.groupId] }));
    const items = [];
    for (const { record } of records) {
      items.push(this._toGroupSummary(record));
    }
    if (safePreview > 0) {
      await IndexedDBManager.runTransaction([IDBStores.STASH_ENTRIES, IDBStores.PAGES], 'readonly', async (tx) => {
        for (const summary of items) {
          if (!summary.itemCount) continue;
          const entries = [];
          await new Promise((resolve, reject) => {
            const request = tx.objectStore(IDBStores.STASH_ENTRIES)
              .index(STASH_ENTRY_POSITION_INDEX)
              .openCursor(this._groupEntryRange(summary.id));
            request.onerror = () => reject(request.error || new Error('收纳组预览游标读取失败'));
            request.onsuccess = () => {
              const current = request.result;
              if (!current || entries.length >= safePreview) return resolve();
              entries.push(current.value);
              current.continue();
            };
          });
          const pageById = await this._loadPagesById(tx, entries.map((entry) => entry.pageId));
          summary.tabs = entries.map((entry) => this._toTabItem(entry, pageById.get(entry.pageId)));
        }
      });
    }
    const lastKey = records.length > 0 ? records[records.length - 1].key : null;
    return {
      items,
      nextCursor: hasMore ? this._encodeCursor(lastKey) : null,
      hasMore
    };
  }

  /**
   * 兼容旧调用方的一次性摘要读取；内部按游标逐页读取，不扫描条目仓储。
   * @param {{ previewLimit?: number }} [options]
   */
  static async listGroupSummaries({ previewLimit = 0 } = {}) {
    const safePreview = Math.max(0, Math.min(25, Math.floor(Number(previewLimit) || 0)));
    const page = await this.listGroupSummariesPage({ limit: 500, previewLimit: safePreview });
    const items = [...page.items];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await this.listGroupSummariesPage({ cursor, limit: 500, previewLimit: safePreview });
      items.push(...next.items);
      cursor = next.nextCursor;
    }
    return items;
  }

  /** 读取收纳总览统计，只聚合组记录上的派生字段。 */
  static async getStashStats() {
    return await IndexedDBManager.runTransaction([IDBStores.STASH_GROUPS], 'readonly', async (tx) => {
      const stats = { groupCount: 0, itemCount: 0, starredCount: 0, lockedCount: 0, archivedCount: 0 };
      await new Promise((resolve, reject) => {
        const request = tx.objectStore(IDBStores.STASH_GROUPS).openCursor();
        request.onerror = () => reject(request.error || new Error('收纳统计游标读取失败'));
        request.onsuccess = () => {
          const current = request.result;
          if (!current) return resolve();
          const group = current.value;
          stats.groupCount += 1;
          stats.itemCount += Math.max(0, Number(group.itemCount) || 0);
          if (group.starred) stats.starredCount += 1;
          if (group.locked) stats.lockedCount += 1;
          if (group.archived) stats.archivedCount += 1;
          current.continue();
        };
      });
      return stats;
    });
  }

  /**
   * 按自然周生成时间线分桶摘要，只扫描组记录。
   * @returns {Promise<Array<{ key: string, startAt: number, endAt: number, groupCount: number, itemCount: number }>>}
   */
  static async listTimelineBuckets() {
    const buckets = new Map();
    await IndexedDBManager.runTransaction([IDBStores.STASH_GROUPS], 'readonly', async (tx) => {
      await new Promise((resolve, reject) => {
        const request = tx.objectStore(IDBStores.STASH_GROUPS).openCursor();
        request.onerror = () => reject(request.error || new Error('时间线分桶游标读取失败'));
        request.onsuccess = () => {
          const current = request.result;
          if (!current) return resolve();
          const group = current.value;
          const date = new Date(Number(group.createdAt) || 0);
          const day = date.getDay() || 7;
          const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - day + 1);
          const startAt = start.getTime();
          const endAt = startAt + 7 * 86400000 - 1;
          const key = new Date(startAt).toISOString().slice(0, 10);
          const bucket = buckets.get(key) || { key, startAt, endAt, groupCount: 0, itemCount: 0 };
          bucket.groupCount += 1;
          bucket.itemCount += Math.max(0, Number(group.itemCount) || 0);
          buckets.set(key, bucket);
          current.continue();
        };
      });
    });
    return [...buckets.values()].sort((a, b) => b.startAt - a.startAt);
  }

  /**
   * 读取全部收纳组（join 三层仓储后按旧版结构返回）
   * @returns {Promise<any[]>}
   */
  static async getAllGroups() {
    return await IndexedDBManager.runTransaction(
      [IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES, IDBStores.PAGES],
      'readonly',
      async (tx) => {
        const groupRecords = await IndexedDBManager.requestToPromise(
          tx.objectStore(IDBStores.STASH_GROUPS).getAll()
        );
        const entryRecords = await IndexedDBManager.requestToPromise(
          tx.objectStore(IDBStores.STASH_ENTRIES).getAll()
        );
        const pageRecords = await IndexedDBManager.requestToPromise(
          tx.objectStore(IDBStores.PAGES).getAll()
        );
        return this._composeGroups(groupRecords, entryRecords, pageRecords);
      }
    );
  }

  /**
   * 通过 pageId 索引精确查询一组 URL 是否已被任何"现存收纳组"收录（去重判定不加载整数组）
   * 必须联表校验条目所属组仍然存在：异常中断可能留下没有组记录的孤儿条目，
   * 若仅凭条目判定，孤儿条目会让对应 URL 永远被去重跳过，进而导致标签页被关闭且数据无处可寻。
   * @param {string[]} urls - 待查询 URL 列表
   * @returns {Promise<Map<string, boolean>>} pageId -> 是否已存在
   */
  static async _queryExistingPageIds(urls) {
    const result = new Map();
    if (!urls || urls.length === 0) return result;
    await IndexedDBManager.runTransaction(
      [IDBStores.STASH_ENTRIES, IDBStores.STASH_GROUPS],
      'readonly',
      async (tx) => {
        const groupsStore = tx.objectStore(IDBStores.STASH_GROUPS);
        const pageIndex = tx.objectStore(IDBStores.STASH_ENTRIES).index('pageId');
        for (const url of urls) {
          const pageId = this.computePageId(url);
          const entries = await IndexedDBManager.requestToPromise(pageIndex.getAll(pageId));
          let exists = false;
          for (const entry of entries) {
            const group = await IndexedDBManager.requestToPromise(groupsStore.get(entry.groupId));
            if (group) {
              exists = true;
              break;
            }
          }
          result.set(pageId, exists);
        }
      }
    );
    return result;
  }

  /**
   * 批量刷新页面实体的标题（对应旧版 existingTabTitleBehavior === 'useLatest' 行为）
   * @param {Map<string, string>} titleUpdates - pageId -> 最新标题
   */
  static async _applyTitleUpdates(titleUpdates) {
    if (!titleUpdates || titleUpdates.size === 0) return;
    await IndexedDBManager.runTransaction([IDBStores.PAGES], 'readwrite', async (tx) => {
      const store = tx.objectStore(IDBStores.PAGES);
      for (const [pageId, title] of titleUpdates) {
        const page = await IndexedDBManager.requestToPromise(store.get(pageId));
        if (page) {
          page.title = String(title).slice(0, 4096);
          store.put(page);
        }
      }
    });
  }

  /**
   * 分批写入任意仓储记录（幂等 put）
   * @param {string} storeName
   * @param {any[]} records
   */
  static async _putChunked(storeName, records) {
    for (const batch of IndexedDBManager.chunk(records, WRITE_BATCH_SIZE)) {
      await IndexedDBManager.runTransaction([storeName], 'readwrite', (tx) => {
        const store = tx.objectStore(storeName);
        for (const record of batch) store.put(record);
      });
    }
  }

  /**
   * 创建收纳组（写入顺序：页面实体 → 收纳记录 → 组记录）
   * 组记录最后写入，保证事务中断时不会出现"半可见"的空组。
   * ⚠️ 调用方必须已持有 IndexedDBManager.withWriteLock 写锁
   * @param {Array<{ url: string, title: string, favIconUrl?: string, pinned?: boolean }>} tabItems
   * @param {string} [customTitle=''] - 自定义组标题
   * @param {any} [settings] - 收纳设置（来自用户配置 stashSettings）
   * @returns {Promise<{ success: boolean, group?: any, skipped?: number }>}
   */
  static async createGroup(tabItems, customTitle = '', settings = {}) {
    const items = (tabItems || []).filter((item) => item && item.url);
    if (items.length === 0) return { success: false };

    let normalizedItems = items;
    const titleUpdates = new Map();

    if (settings.allowDuplicates === false) {
      // 通过 pageId 索引精确判定重复，不加载整数组
      const pageIdExists = await this._queryExistingPageIds([...new Set(items.map((item) => item.url))]);
      const seenIncoming = new Set();
      normalizedItems = items.filter((item) => {
        const pageId = this.computePageId(item.url);
        if (pageIdExists.get(pageId) || seenIncoming.has(item.url)) {
          if (item.title) titleUpdates.set(pageId, item.title);
          return false;
        }
        seenIncoming.add(item.url);
        return true;
      });
      // 旧版语义：仅当禁止重复时才依据 useLatest 刷新已有条目标题（两层模型下即刷新页面实体）
      if (settings.existingTabTitleBehavior === 'useLatest') {
        await this._applyTitleUpdates(titleUpdates);
      }
    }

    if (normalizedItems.length === 0) {
      return { success: true, group: null, skipped: items.length };
    }

    const now = Date.now();
    const defaultTitle = customTitle || this._formatDefaultTitle(now, normalizedItems.length);
    const groupId = `stash_grp_${now}_${Math.random().toString(36).substring(2, 7)}`;
    const updateTitle = settings.existingTabTitleBehavior === 'useLatest';

    const pagesById = new Map();
    const entryRecords = normalizedItems.map((item, position) => {
      const pageId = this.computePageId(item.url);
      if (!pagesById.has(pageId)) {
        pagesById.set(pageId, {
          pageId,
          url: item.url || '',
          domain: this.extractDomain(item.url),
          title:
            typeof item.title === 'string' && item.title
              ? item.title.slice(0, 4096)
              : item.url || '无标题页面',
          favIconUrl: typeof item.favIconUrl === 'string' ? item.favIconUrl : '',
          createdAt: now,
          updatedAt: now
        });
      }
      return {
        entryId: `${groupId}::tab_item_${Math.random().toString(36).substring(2, 9)}`,
        groupId,
        pageId,
        createdAt: now,
        position,
        pinned: Boolean(item.pinned),
        archived: false
      };
    });

    const groupColor = typeof settings === 'object' && typeof settings.color === 'string'
      ? settings.color
      : '';

    const groupRecord = {
      groupId,
      createdAt: now,
      title: defaultTitle,
      color: groupColor,
      locked: false,
      starred: false,
      starRank: 0,
      archived: false,
      itemCount: entryRecords.length,
      nextPosition: entryRecords.length,
      updatedAt: now
    };

    const enqueue = await SyncOutbox.isActive();
    const stores = [IDBStores.PAGES, IDBStores.STASH_ENTRIES, IDBStores.STASH_GROUPS];
    if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);

    // 单事务原子写入三层记录：任一环节失败整体回滚，
    // 杜绝"条目已写入而组记录缺失"的孤儿条目污染去重判定
    await IndexedDBManager.runTransaction(
      stores,
      'readwrite',
      async (tx) => {
        const pagesStore = tx.objectStore(IDBStores.PAGES);
        const entriesStore = tx.objectStore(IDBStores.STASH_ENTRIES);
        const groupsStore = tx.objectStore(IDBStores.STASH_GROUPS);

        // 1. 页面实体（同一 URL 复用已有实体，仅刷新动态字段）
        for (const page of pagesById.values()) {
          const existing = await IndexedDBManager.requestToPromise(pagesStore.get(page.pageId));
          if (existing) {
            existing.favIconUrl = page.favIconUrl || existing.favIconUrl;
            existing.domain = page.domain || existing.domain;
            existing.updatedAt = page.updatedAt;
            if (updateTitle && page.title) existing.title = page.title;
            if (enqueue) {
              const op = await SyncOutbox.enqueueInTx(tx, {
                entityType: SyncEntityTypes.PAGE,
                entityId: existing.pageId,
                op: SyncOps.PATCH,
                fields: {
                  favIconUrl: existing.favIconUrl,
                  domain: existing.domain,
                  title: existing.title,
                  url: existing.url
                }
              });
              if (op) {
                existing.fieldRevs = { ...(existing.fieldRevs || {}), ...op.fieldRevs };
                existing.revision = op.lamport;
                existing.originDeviceId = op.deviceId;
              }
            }
            pagesStore.put(existing);
          } else {
            if (enqueue) {
              const op = await SyncOutbox.enqueueInTx(tx, {
                entityType: SyncEntityTypes.PAGE,
                entityId: page.pageId,
                op: SyncOps.UPSERT,
                fields: {
                  url: page.url,
                  domain: page.domain,
                  title: page.title,
                  favIconUrl: page.favIconUrl,
                  createdAt: page.createdAt
                }
              });
              if (op) {
                page.fieldRevs = { ...op.fieldRevs };
                page.revision = op.lamport;
                page.originDeviceId = op.deviceId;
              }
            }
            pagesStore.put(page);
          }
        }

        // 2. 收纳记录
        for (const entry of entryRecords) {
          if (enqueue) {
            const op = await SyncOutbox.enqueueInTx(tx, {
              entityType: SyncEntityTypes.STASH_ENTRY,
              entityId: entry.entryId,
              op: SyncOps.UPSERT,
              fields: {
                groupId: entry.groupId,
                pageId: entry.pageId,
                createdAt: entry.createdAt,
                position: entry.position,
                pinned: entry.pinned,
                archived: entry.archived
              }
            });
            if (op) {
              entry.fieldRevs = { ...op.fieldRevs };
              entry.revision = op.lamport;
              entry.originDeviceId = op.deviceId;
            }
          }
          entriesStore.put(entry);
        }

        // 3. 组记录（同一事务内写入，天然无"半可见"窗口）
        if (enqueue) {
          const op = await SyncOutbox.enqueueInTx(tx, {
            entityType: SyncEntityTypes.STASH_GROUP,
            entityId: groupId,
            op: SyncOps.UPSERT,
            fields: {
              title: groupRecord.title,
              color: groupRecord.color,
              locked: groupRecord.locked,
              starred: groupRecord.starred,
              archived: groupRecord.archived,
              createdAt: groupRecord.createdAt
            }
          });
          if (op) {
            groupRecord.fieldRevs = { ...op.fieldRevs };
            groupRecord.revision = op.lamport;
            groupRecord.originDeviceId = op.deviceId;
          }
        }
        groupsStore.put(groupRecord);
      }
    );
    if (enqueue) SyncOutbox.flushDirty();

    // 返回与旧版结构完全一致的组对象（entryId 已含组命名空间，跨组唯一）
    return {
      success: true,
      group: {
        id: groupId,
        createdAt: now,
        title: defaultTitle,
        color: groupColor,
        locked: false,
        starred: false,
        archived: false,
        itemCount: entryRecords.length,
        tabs: normalizedItems.map((item, index) => ({
          id: entryRecords[index].entryId,
          url: item.url || '',
          title: item.title || item.url || '无标题页面',
          favIconUrl: typeof item.favIconUrl === 'string' ? item.favIconUrl : '',
          pinned: Boolean(item.pinned)
        }))
      }
    };
  }

  /**
   * 更新收纳组属性（标题、锁定、星标、归档）
   * ⚠️ 调用方必须已持有跨上下文写锁
   * @param {string} groupId
   * @param {Partial<{ title: string, locked: boolean, starred: boolean, archived: boolean }>} updates
   * @returns {Promise<boolean>}
   */
  static async updateGroup(groupId, updates) {
    const enqueue = await SyncOutbox.isActive();
    const stores = [IDBStores.STASH_GROUPS];
    if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);
    const ok = await IndexedDBManager.runTransaction(stores, 'readwrite', async (tx) => {
      const store = tx.objectStore(IDBStores.STASH_GROUPS);
      const existing = await IndexedDBManager.requestToPromise(store.get(groupId));
      if (!existing || !updates || typeof updates !== 'object') return false;
      const allowed = ['title', 'color', 'locked', 'starred', 'archived'];
      const fields = {};
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
          existing[key] = (key === 'title' || key === 'color') ? String(updates[key]).slice(0, 200) : Boolean(updates[key]);
          fields[key] = existing[key];
        }
      }
      existing.starRank = existing.starred ? 1 : 0;
      existing.updatedAt = Date.now();
      if (enqueue && Object.keys(fields).length > 0) {
        const op = await SyncOutbox.enqueueInTx(tx, {
          entityType: SyncEntityTypes.STASH_GROUP,
          entityId: groupId,
          op: SyncOps.PATCH,
          fields
        });
        if (op) {
          existing.fieldRevs = { ...(existing.fieldRevs || {}), ...op.fieldRevs };
          existing.revision = op.lamport;
          existing.originDeviceId = op.deviceId;
        }
      }
      store.put(existing);
      return true;
    });
    if (ok && enqueue) SyncOutbox.flushDirty();
    return ok;
  }

  /**
   * 删除指定收纳组及其全部收纳记录（不删除页面实体，供后续同 URL 复用）
   * ⚠️ 调用方必须已持有跨上下文写锁
   * @param {string} groupId
   * @param {boolean} [force=false] - 锁定组是否强制删除
   * @returns {Promise<boolean>}
   */
  static async _deleteGroupUnlocked(groupId, force = false) {
    const enqueue = await SyncOutbox.isActive();
    const stores = [IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES, IDBStores.PAGES, IDBStores.TOMBSTONES];
    if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);
    const ok = await IndexedDBManager.runTransaction(
      stores,
      'readwrite',
      async (tx) => {
        const groupsStore = tx.objectStore(IDBStores.STASH_GROUPS);
        const entriesStore = tx.objectStore(IDBStores.STASH_ENTRIES);
        const group = await IndexedDBManager.requestToPromise(groupsStore.get(groupId));
        if (!group) return true; // 组不存在视为已删除（与旧版语义一致）
        if (group.locked && !force) return false;
        const entries = await IndexedDBManager.requestToPromise(
          entriesStore.index('groupId').getAll(groupId)
        );
        const pages = await this._loadPagesForEntries(tx, entries);
        const now = Date.now();
        groupsStore.delete(groupId);
        for (const entry of entries) {
          entriesStore.delete(entry.entryId);
          tx.objectStore(IDBStores.TOMBSTONES).put(this._buildTombstone(
            SyncEntityTypes.STASH_ENTRY,
            entry.entryId,
            {
              entry: this._clone(entry),
              page: pages.find((page) => page.pageId === entry.pageId) || null,
              groupId
            },
            now
          ));
          if (enqueue) {
            await SyncOutbox.enqueueInTx(tx, {
              entityType: SyncEntityTypes.STASH_ENTRY,
              entityId: entry.entryId,
              op: SyncOps.DELETE,
              fields: { groupId }
            });
          }
        }
        tx.objectStore(IDBStores.TOMBSTONES).put(this._buildTombstone(
          SyncEntityTypes.STASH_GROUP,
          groupId,
          { group: this._clone(group), entries: entries.map((entry) => this._clone(entry)), pages },
          now
        ));
        if (enqueue) {
          await SyncOutbox.enqueueInTx(tx, {
            entityType: SyncEntityTypes.STASH_GROUP,
            entityId: groupId,
            op: SyncOps.DELETE,
            fields: { groupId }
          });
        }
        return true;
      }
    );
    if (ok && enqueue) SyncOutbox.flushDirty();
    return ok;
  }

  /**
   * 删除指定收纳组（语义与旧版一致）
   * @param {string} groupId
   * @param {boolean} [force=false]
   * @returns {Promise<boolean>}
   */
  static async deleteGroup(groupId, force = false) {
    return await this._deleteGroupUnlocked(groupId, force);
  }

  /**
   * 删除收纳组内单个条目；非锁定组变空后自动清理该组
   * ⚠️ 调用方必须已持有跨上下文写锁
   * @param {string} groupId
   * @param {string} itemId - 条目 ID（entryId）
   * @returns {Promise<boolean>}
   */
  static async deleteTabItem(groupId, itemId) {
    const enqueue = await SyncOutbox.isActive();
    const stores = [IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES, IDBStores.PAGES, IDBStores.TOMBSTONES];
    if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);
    const ok = await IndexedDBManager.runTransaction(
      stores,
      'readwrite',
      async (tx) => {
        const groupsStore = tx.objectStore(IDBStores.STASH_GROUPS);
        const entriesStore = tx.objectStore(IDBStores.STASH_ENTRIES);
        const group = await IndexedDBManager.requestToPromise(groupsStore.get(groupId));
        if (!group) return false;

        const entries = await IndexedDBManager.requestToPromise(
          entriesStore.index('groupId').getAll(groupId)
        );
        const target = entries.find((entry) => entry.entryId === itemId);
        if (!target) {
          // 条目不存在：与旧版一致，仍视为成功
          return true;
        }
        const remaining = entries.filter((entry) => entry.entryId !== itemId);
        const pages = await this._loadPagesForEntries(tx, [target]);
        const now = Date.now();
        entriesStore.delete(itemId);
        tx.objectStore(IDBStores.TOMBSTONES).put(this._buildTombstone(
          SyncEntityTypes.STASH_ENTRY,
          itemId,
          { entry: this._clone(target), page: pages[0] || null, groupId },
          now
        ));
        if (enqueue) {
          await SyncOutbox.enqueueInTx(tx, {
            entityType: SyncEntityTypes.STASH_ENTRY,
            entityId: itemId,
            op: SyncOps.DELETE,
            fields: { groupId }
          });
        }
        if (remaining.length === 0 && !group.locked) {
          groupsStore.delete(groupId);
          tx.objectStore(IDBStores.TOMBSTONES).put(this._buildTombstone(
            SyncEntityTypes.STASH_GROUP,
            groupId,
            { group: this._clone(group), entries: [this._clone(target)], pages },
            now
          ));
          if (enqueue) {
            await SyncOutbox.enqueueInTx(tx, {
              entityType: SyncEntityTypes.STASH_GROUP,
              entityId: groupId,
              op: SyncOps.DELETE,
              fields: { groupId }
            });
          }
        } else {
          group.itemCount = remaining.length;
          group.starRank = group.starred ? 1 : 0;
          group.updatedAt = now;
          groupsStore.put(group);
        }
        return true;
      }
    );
    if (ok && enqueue) SyncOutbox.flushDirty();
    return ok;
  }

  /**
   * 向既有收纳组追加单个条目（AI 增强写入通道）
   * 写入顺序与 createGroup 一致：页面实体 → 收纳记录 → 组记录 updatedAt；
   * 页面、条目与组记录在同一事务内原子提交，outbox 操作同事务追加。
   * ⚠️ 调用方必须已持有跨上下文写锁
   * @param {string} groupId
   * @param {{ url: string, title?: string, favIconUrl?: string, pinned?: boolean }} tabItem
   * @param {any} [settings] - 收纳设置（allowDuplicates 等，语义与 createGroup 一致）
   * @returns {Promise<{ success: boolean, added?: boolean, item?: any, skipped?: number, error?: string }>}
   */
  static async addTabItemToGroup(groupId, tabItem, settings = {}) {
    if (!groupId || !tabItem || typeof tabItem.url !== 'string' || !tabItem.url) {
      return { success: false, error: '缺少有效的 groupId 或 url' };
    }
    const cleanUrl = tabItem.url;
    const pageId = this.computePageId(cleanUrl);

    const enqueue = await SyncOutbox.isActive();
    const now = Date.now();

    // 去重判定与 createGroup 语义一致：禁止重复时该 URL 已被任何现存组收录则跳过
    if (settings.allowDuplicates === false) {
      const pageIdExists = await this._queryExistingPageIds([cleanUrl]);
      if (pageIdExists.get(pageId)) {
        return { success: true, added: false, skipped: 1 };
      }
    }

    const stores = [IDBStores.PAGES, IDBStores.STASH_ENTRIES, IDBStores.STASH_GROUPS];
    if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);

    const title = typeof tabItem.title === 'string' && tabItem.title.trim()
      ? tabItem.title.slice(0, 4096)
      : cleanUrl;
    const entryId = `${groupId}::tab_item_${Math.random().toString(36).substring(2, 9)}`;

    const ok = await IndexedDBManager.runTransaction(stores, 'readwrite', async (tx) => {
      const groupsStore = tx.objectStore(IDBStores.STASH_GROUPS);
      const group = await IndexedDBManager.requestToPromise(groupsStore.get(groupId));
      if (!group) return false;

      const position = Number.isFinite(Number(group.nextPosition))
        ? Number(group.nextPosition)
        : Math.max(0, Number(group.itemCount) || 0);
      group.itemCount = Math.max(0, Number(group.itemCount) || 0) + 1;
      group.nextPosition = position + 1;
      group.starRank = group.starred ? 1 : 0;
      group.updatedAt = now;
      groupsStore.put(group);

      const entryRecord = {
        entryId,
        groupId,
        pageId,
        createdAt: now,
        position,
        pinned: Boolean(tabItem.pinned),
        archived: false
      };

      // 1. 页面实体（同一 URL 复用已有实体，仅刷新动态字段）
      const pagesStore = tx.objectStore(IDBStores.PAGES);
      const existingPage = await IndexedDBManager.requestToPromise(pagesStore.get(pageId));
      const pageFields = {
        url: cleanUrl,
        domain: this.extractDomain(cleanUrl),
        title,
        favIconUrl: typeof tabItem.favIconUrl === 'string' ? tabItem.favIconUrl : ''
      };
      if (existingPage) {
        existingPage.favIconUrl = pageFields.favIconUrl || existingPage.favIconUrl;
        existingPage.domain = pageFields.domain || existingPage.domain;
        existingPage.updatedAt = now;
        if (enqueue) {
          const op = await SyncOutbox.enqueueInTx(tx, {
            entityType: SyncEntityTypes.PAGE,
            entityId: existingPage.pageId,
            op: SyncOps.PATCH,
            fields: {
              favIconUrl: existingPage.favIconUrl,
              domain: existingPage.domain,
              title: existingPage.title,
              url: existingPage.url
            }
          });
          if (op) {
            existingPage.fieldRevs = { ...(existingPage.fieldRevs || {}), ...op.fieldRevs };
            existingPage.revision = op.lamport;
            existingPage.originDeviceId = op.deviceId;
          }
        }
        pagesStore.put(existingPage);
      } else {
        const pageRecord = {
          pageId,
          ...pageFields,
          createdAt: now,
          updatedAt: now
        };
        if (enqueue) {
          const op = await SyncOutbox.enqueueInTx(tx, {
            entityType: SyncEntityTypes.PAGE,
            entityId: pageId,
            op: SyncOps.UPSERT,
            fields: {
              url: pageRecord.url,
              domain: pageRecord.domain,
              title: pageRecord.title,
              favIconUrl: pageRecord.favIconUrl,
              createdAt: pageRecord.createdAt
            }
          });
          if (op) {
            pageRecord.fieldRevs = { ...op.fieldRevs };
            pageRecord.revision = op.lamport;
            pageRecord.originDeviceId = op.deviceId;
          }
        }
        pagesStore.put(pageRecord);
      }

      // 2. 收纳记录
      if (enqueue) {
        const op = await SyncOutbox.enqueueInTx(tx, {
          entityType: SyncEntityTypes.STASH_ENTRY,
          entityId: entryId,
          op: SyncOps.UPSERT,
          fields: {
            groupId,
            pageId,
            createdAt: entryRecord.createdAt,
            position: entryRecord.position,
            pinned: entryRecord.pinned,
            archived: entryRecord.archived
          }
        });
        if (op) {
          entryRecord.fieldRevs = { ...op.fieldRevs };
          entryRecord.revision = op.lamport;
          entryRecord.originDeviceId = op.deviceId;
        }
      }
      tx.objectStore(IDBStores.STASH_ENTRIES).put(entryRecord);

      // 3. 组记录仅刷新本地 updatedAt（同步字段未变化，无需 outbox 操作）
      group.updatedAt = now;
      groupsStore.put(group);
      return true;
    });
    if (ok && enqueue) SyncOutbox.flushDirty();
    if (!ok) return { success: false, error: '收纳组不存在' };

    return {
      success: true,
      added: true,
      item: {
        id: entryId,
        url: cleanUrl,
        title,
        favIconUrl: typeof tabItem.favIconUrl === 'string' ? tabItem.favIconUrl : '',
        pinned: Boolean(tabItem.pinned)
      }
    };
  }

  /**
   * 编辑既有收纳条目（AI 增强写入通道）
   * 标题遵循两层模型语义：title 属于页面实体（同 URL 条目共享）；
   * 修改 url 会将条目重新指向新 URL 的页面实体（原页面实体保留供其他条目复用）。
   * ⚠️ 调用方必须已持有跨上下文写锁
   * @param {string} groupId
   * @param {string} itemId - 条目 ID（entryId）
   * @param {Partial<{ title: string, url: string, pinned: boolean, archived: boolean }>} updates
   * @returns {Promise<boolean>}
   */
  static async updateTabItem(groupId, itemId, updates) {
    if (!itemId || !updates || typeof updates !== 'object') return false;
    const allowed = ['title', 'url', 'pinned', 'archived'];
    const hasField = allowed.some((key) => Object.prototype.hasOwnProperty.call(updates, key));
    if (!hasField) return false;

    const enqueue = await SyncOutbox.isActive();
    const now = Date.now();
    const newUrl = typeof updates.url === 'string' ? updates.url.trim() : '';
    const newTitle = typeof updates.title === 'string' ? updates.title.slice(0, 4096) : undefined;

    const stores = [IDBStores.PAGES, IDBStores.STASH_ENTRIES];
    if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);

    const ok = await IndexedDBManager.runTransaction(stores, 'readwrite', async (tx) => {
      const entriesStore = tx.objectStore(IDBStores.STASH_ENTRIES);
      const pagesStore = tx.objectStore(IDBStores.PAGES);
      const entry = await IndexedDBManager.requestToPromise(entriesStore.get(itemId));
      if (!entry || (groupId && entry.groupId !== groupId)) return false;

      // 修改 URL：重新指向新页面实体（新页面不存在则创建，未提供新标题时沿用原标题）
      if (newUrl) {
        const newPageId = this.computePageId(newUrl);
        if (newPageId !== entry.pageId) {
          const oldPage = await IndexedDBManager.requestToPromise(pagesStore.get(entry.pageId));
          const existingNewPage = await IndexedDBManager.requestToPromise(pagesStore.get(newPageId));
          if (existingNewPage) {
            existingNewPage.updatedAt = now;
            if (enqueue) {
              const op = await SyncOutbox.enqueueInTx(tx, {
                entityType: SyncEntityTypes.PAGE,
                entityId: existingNewPage.pageId,
                op: SyncOps.PATCH,
                fields: {
                  favIconUrl: existingNewPage.favIconUrl,
                  domain: existingNewPage.domain,
                  title: existingNewPage.title,
                  url: existingNewPage.url
                }
              });
              if (op) {
                existingNewPage.fieldRevs = { ...(existingNewPage.fieldRevs || {}), ...op.fieldRevs };
                existingNewPage.revision = op.lamport;
                existingNewPage.originDeviceId = op.deviceId;
              }
            }
            pagesStore.put(existingNewPage);
          } else {
            const pageRecord = {
              pageId: newPageId,
              url: newUrl,
              domain: this.extractDomain(newUrl),
              title: newTitle !== undefined ? newTitle : (oldPage?.title || newUrl),
              favIconUrl: oldPage?.favIconUrl || '',
              createdAt: now,
              updatedAt: now
            };
            if (enqueue) {
              const op = await SyncOutbox.enqueueInTx(tx, {
                entityType: SyncEntityTypes.PAGE,
                entityId: newPageId,
                op: SyncOps.UPSERT,
                fields: {
                  url: pageRecord.url,
                  domain: pageRecord.domain,
                  title: pageRecord.title,
                  favIconUrl: pageRecord.favIconUrl,
                  createdAt: pageRecord.createdAt
                }
              });
              if (op) {
                pageRecord.fieldRevs = { ...op.fieldRevs };
                pageRecord.revision = op.lamport;
                pageRecord.originDeviceId = op.deviceId;
              }
            }
            pagesStore.put(pageRecord);
          }
          entry.pageId = newPageId;
        }
      }

      // 修改标题：标题属于页面实体共享层（同 URL 的全部条目同步可见）
      if (newTitle !== undefined) {
        const page = await IndexedDBManager.requestToPromise(pagesStore.get(entry.pageId));
        if (page) {
          page.title = newTitle;
          page.updatedAt = now;
          if (enqueue) {
            const op = await SyncOutbox.enqueueInTx(tx, {
              entityType: SyncEntityTypes.PAGE,
              entityId: page.pageId,
              op: SyncOps.PATCH,
              fields: { title: page.title, url: page.url, domain: page.domain, favIconUrl: page.favIconUrl }
            });
            if (op) {
              page.fieldRevs = { ...(page.fieldRevs || {}), ...op.fieldRevs };
              page.revision = op.lamport;
              page.originDeviceId = op.deviceId;
            }
          }
          pagesStore.put(page);
        }
      }

      const entryFields = {};
      if (typeof updates.pinned === 'boolean') {
        entry.pinned = updates.pinned;
        entryFields.pinned = updates.pinned;
      }
      if (typeof updates.archived === 'boolean') {
        entry.archived = updates.archived;
        entryFields.archived = updates.archived;
      }
      if (entry.pageId) entryFields.pageId = entry.pageId;

      if (enqueue && Object.keys(entryFields).length > 0) {
        const op = await SyncOutbox.enqueueInTx(tx, {
          entityType: SyncEntityTypes.STASH_ENTRY,
          entityId: entry.entryId,
          op: SyncOps.PATCH,
          fields: entryFields
        });
        if (op) {
          entry.fieldRevs = { ...(entry.fieldRevs || {}), ...op.fieldRevs };
          entry.revision = op.lamport;
          entry.originDeviceId = op.deviceId;
        }
      }
      entriesStore.put(entry);
      return true;
    });
    if (ok && enqueue) SyncOutbox.flushDirty();
    return ok;
  }

  /**
   * 清空所有非锁定的收纳组（includeLocked 为 true 时连同锁定组一并清空）
   * ⚠️ 调用方必须已持有跨上下文写锁
   * @param {boolean} [includeLocked=false]
   * @returns {Promise<boolean>}
   */
  static async clearAll(includeLocked = false) {
    const enqueue = await SyncOutbox.isActive();
    const stores = [IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES, IDBStores.PAGES, IDBStores.TOMBSTONES];
    if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);
    const ok = await IndexedDBManager.runTransaction(
      stores,
      'readwrite',
      async (tx) => {
        const groupsStore = tx.objectStore(IDBStores.STASH_GROUPS);
        const entriesStore = tx.objectStore(IDBStores.STASH_ENTRIES);
        const tombsStore = tx.objectStore(IDBStores.TOMBSTONES);
        const groups = await IndexedDBManager.requestToPromise(groupsStore.getAll());
        const now = Date.now();
        for (const group of groups) {
          if (group.locked && !includeLocked) continue;
          const entries = await IndexedDBManager.requestToPromise(
            entriesStore.index('groupId').getAll(group.groupId)
          );
          const pages = await this._loadPagesForEntries(tx, entries);
          groupsStore.delete(group.groupId);
          for (const entry of entries) {
            entriesStore.delete(entry.entryId);
            tombsStore.put(this._buildTombstone(
              SyncEntityTypes.STASH_ENTRY,
              entry.entryId,
              {
                entry: this._clone(entry),
                page: pages.find((page) => page.pageId === entry.pageId) || null,
                groupId: group.groupId
              },
              now
            ));
            if (enqueue) {
              await SyncOutbox.enqueueInTx(tx, {
                entityType: SyncEntityTypes.STASH_ENTRY,
                entityId: entry.entryId,
                op: SyncOps.DELETE,
                fields: { groupId: group.groupId }
              });
            }
          }
          tombsStore.put(this._buildTombstone(
            SyncEntityTypes.STASH_GROUP,
            group.groupId,
            { group: this._clone(group), entries: entries.map((entry) => this._clone(entry)), pages },
            now
          ));
          if (enqueue) {
            await SyncOutbox.enqueueInTx(tx, {
              entityType: SyncEntityTypes.STASH_GROUP,
              entityId: group.groupId,
              op: SyncOps.DELETE,
              fields: { groupId: group.groupId }
            });
          }
        }
        return true;
      }
    );
    if (ok && enqueue) SyncOutbox.flushDirty();
    return ok;
  }

  /**
   * 浅拷贝记录，避免墓碑快照与仓储对象互相污染
   * @param {any} value
   * @returns {any}
   */
  static _clone(value) {
    if (!value || typeof value !== 'object') return value;
    return { ...value };
  }

  /**
   * 构造带恢复快照的墓碑记录
   * @param {string} entityType
   * @param {string} entityId
   * @param {any} snapshot
   * @param {number} now
   */
  static _buildTombstone(entityType, entityId, snapshot, now = Date.now()) {
    return {
      tombstoneId: `${entityType}::${entityId}`,
      entityType,
      entityId,
      deletedAt: now,
      expiresAt: now + TOMBSTONE_TTL_MS,
      snapshot
    };
  }

  /**
   * 在当前事务内按条目收集去重后的页面实体
   * @param {IDBTransaction} tx
   * @param {any[]} entries
   * @returns {Promise<any[]>}
   */
  static async _loadPagesForEntries(tx, entries) {
    const pagesStore = tx.objectStore(IDBStores.PAGES);
    const pagesById = new Map();
    for (const entry of entries || []) {
      if (!entry?.pageId || pagesById.has(entry.pageId)) continue;
      const page = await IndexedDBManager.requestToPromise(pagesStore.get(entry.pageId));
      if (page) pagesById.set(entry.pageId, this._clone(page));
    }
    return [...pagesById.values()];
  }

  /**
   * 清理标签 URL 完全相同的重复收纳组（锁定组不参与删除，语义与旧版一致）
   * ⚠️ 调用方必须已持有跨上下文写锁
   * @returns {Promise<{ success: boolean, removedCount: number, groupCountAfter: number, error?: string }>}
   */
  static async deduplicateGroups() {
    const groups = await this.getAllGroups();
    const seen = new Set();
    const duplicateIds = [];
    let retainedCount = 0;

    for (const group of groups) {
      const urls = Array.isArray(group.tabs)
        ? group.tabs.map((tab) => String(tab?.url || '').trim()).filter(Boolean).sort()
        : [];
      const fingerprint = JSON.stringify(urls);
      if (seen.has(fingerprint) && !group.locked) {
        duplicateIds.push(group.id);
        continue;
      }
      seen.add(fingerprint);
      retainedCount++;
    }

    if (duplicateIds.length === 0) {
      return { success: true, removedCount: 0, groupCountAfter: groups.length };
    }

    for (const groupId of duplicateIds) {
      const ok = await this._deleteGroupUnlocked(groupId, true);
      if (!ok) {
        return { success: false, removedCount: 0, groupCountAfter: groups.length, error: '删除重复收纳组失败' };
      }
    }
    return { success: true, removedCount: duplicateIds.length, groupCountAfter: retainedCount };
  }

  /**
   * 分页读取指定收纳组的条目（不加载其余组数据，支撑万级 URL 场景）
   * @param {string} groupId
   * @param {{ offset?: number, limit?: number }} [options]
   * @returns {Promise<{ items: any[], total: number, offset: number, limit: number }>}
   */
  static async getGroupPage(groupId, { offset = 0, limit = 50, cursor = null } = {}) {
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 50)));
    const decodedCursor = this._decodeCursor(cursor);
    return await IndexedDBManager.runTransaction(
      [IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES, IDBStores.PAGES],
      'readonly',
      async (tx) => {
        const group = await IndexedDBManager.requestToPromise(
          tx.objectStore(IDBStores.STASH_GROUPS).get(groupId)
        );
        const total = Math.max(0, Number(group?.itemCount) || 0);
        const collected = [];
        let hasMore = false;
        let skipped = 0;
        await new Promise((resolve, reject) => {
          const request = tx.objectStore(IDBStores.STASH_ENTRIES)
            .index(STASH_ENTRY_POSITION_INDEX)
            .openCursor(this._groupEntryRange(groupId, Array.isArray(decodedCursor) ? decodedCursor : null, Boolean(decodedCursor)));
          request.onerror = () => reject(request.error || new Error('收纳组分页游标读取失败'));
          request.onsuccess = () => {
            const current = request.result;
            if (!current) return resolve();
            if (!decodedCursor && skipped < safeOffset) {
              skipped += 1;
              current.continue();
              return;
            }
            if (collected.length >= safeLimit) {
              hasMore = true;
              return resolve();
            }
            collected.push({ entry: current.value, key: current.key });
            current.continue();
          };
        });
        const pageById = await this._loadPagesById(tx, collected.map((item) => item.entry.pageId));
        const items = collected.map((item) => this._toTabItem(item.entry, pageById.get(item.entry.pageId)));
        const lastKey = collected.length > 0 ? collected[collected.length - 1].key : null;
        return {
          items,
          total,
          offset: safeOffset,
          limit: safeLimit,
          nextCursor: hasMore ? this._encodeCursor(lastKey) : null,
          hasMore
        };
      }
    );
  }

  /**
   * 按关键字检索页面实体（标题 / URL 模糊匹配，命中后经 pageId 索引定位收纳记录）
   * @param {string} keyword
   * @param {{ limit?: number }} [options]
   * @returns {Promise<Array<{ groupId: string, itemId: string, url: string, title: string }>>}
   */
  static async searchEntries(keyword, { limit = 100, cursor = null, paginated = false, scanLimit = DEFAULT_SEARCH_SCAN_LIMIT } = {}) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return paginated ? { items: [], nextCursor: null, hasMore: false } : [];
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const maxScan = Math.max(safeLimit, Math.floor(Number(scanLimit) || DEFAULT_SEARCH_SCAN_LIMIT));
    const startKey = this._decodeCursor(cursor);
    const result = await IndexedDBManager.runTransaction(
      [IDBStores.PAGES, IDBStores.STASH_ENTRIES],
      'readonly',
      async (tx) => {
        const pagesStore = tx.objectStore(IDBStores.PAGES);
        const entryIndex = tx.objectStore(IDBStores.STASH_ENTRIES).index('pageId');
        const scannedPages = [];
        await new Promise((resolve, reject) => {
          const range = startKey == null ? null : IDBKeyRange.lowerBound(startKey, true);
          const request = pagesStore.openCursor(range);
          request.onerror = () => reject(request.error || new Error('收纳检索游标读取失败'));
          request.onsuccess = () => {
            const current = request.result;
            if (!current) return resolve();
            scannedPages.push({ key: current.key, page: current.value || {} });
            if (scannedPages.length >= maxScan) return resolve();
            current.continue();
          };
        });

        const items = [];
        let lastKey = null;
        for (const { key, page } of scannedPages) {
          lastKey = key;
          const hit = String(page.title || '').toLowerCase().includes(kw)
            || String(page.url || '').toLowerCase().includes(kw);
          if (!hit) continue;
          const entries = await IndexedDBManager.requestToPromise(entryIndex.getAll(page.pageId));
          for (const entry of entries) {
            items.push({
              groupId: entry.groupId,
              itemId: entry.entryId,
              url: page.url,
              title: page.title,
              favIconUrl: page.favIconUrl || ''
            });
            if (items.length >= safeLimit) {
              return {
                items,
                nextCursor: this._encodeCursor(lastKey),
                hasMore: true,
                scanned: scannedPages.length
              };
            }
          }
        }
        return {
          items,
          nextCursor: scannedPages.length >= maxScan ? this._encodeCursor(lastKey) : null,
          hasMore: scannedPages.length >= maxScan,
          scanned: scannedPages.length
        };
      }
    );
    return paginated ? result : result.items;
  }

  /**
   * 导入旧版结构（chrome.storage 数组 / 解析后的外部数据）的收纳组
   * 主键完全由源数据推导（entryId 以 groupId 命名空间隔离），重复执行为幂等 upsert，
   * 迁移中断后重跑不会产生重复记录。
   * ⚠️ 调用方必须已持有跨上下文写锁（门面导入与迁移流程均在其锁内调用）
   * @param {any[]} legacyGroups - 旧版结构收纳组数组
   * @returns {Promise<{ success: boolean, groupCount: number, entryCount: number }>}
   */
  static async importGroups(legacyGroups) {
    if (!Array.isArray(legacyGroups) || legacyGroups.length === 0) {
      return { success: true, groupCount: 0, entryCount: 0 };
    }

    const pageRecords = new Map();
    const entryRecords = [];
    const groupRecords = [];

    for (const group of legacyGroups) {
      if (!group || !group.id) continue;
      const createdAt = typeof group.createdAt === 'number' ? group.createdAt : Date.now();
      const tabs = Array.isArray(group.tabs) ? group.tabs : [];

      tabs.forEach((tab, position) => {
        if (!tab || !tab.url) return;
        const pageId = this.computePageId(tab.url);
        if (!pageRecords.has(pageId)) {
          pageRecords.set(pageId, {
            pageId,
            url: tab.url,
            domain: this.extractDomain(tab.url),
            title:
              typeof tab.title === 'string' && tab.title.trim()
                ? tab.title.slice(0, 4096)
                : tab.url,
            favIconUrl: typeof tab.favIconUrl === 'string' ? tab.favIconUrl : '',
            createdAt,
            updatedAt: createdAt
          });
        }
        // entryId 以 groupId 命名空间隔离：跨组不冲突、重跑幂等；
        // 缺失 id 的脏数据用确定性指纹兜底，避免重跑产生随机重复。
        // 若 tab.id 已携带组前缀（如从 getAllGroups 组装结果或旧备份恢复而来），
        // 必须先剥离全部重复前缀再拼接，否则幂等 upsert 失效、恢复备份会把每个标签翻倍
        let tabKey = typeof tab.id === 'string' ? tab.id : '';
        const groupPrefix = `${group.id}::`;
        while (tabKey.startsWith(groupPrefix)) {
          tabKey = tabKey.slice(groupPrefix.length);
        }
        if (!tabKey) {
          tabKey = `t_${this.computePageId(`${group.id}::${position}::${tab.url}`)}`;
        }
        entryRecords.push({
          entryId: `${group.id}::${tabKey}`,
          groupId: group.id,
          pageId,
          createdAt,
          position,
          pinned: Boolean(tab.pinned),
          archived: Boolean(tab.archived)
        });
      });

      groupRecords.push({
        groupId: group.id,
        createdAt,
        title: typeof group.title === 'string' ? group.title.slice(0, 200) : '',
        color: typeof group.color === 'string' ? group.color : '',
        locked: Boolean(group.locked),
        starred: Boolean(group.starred),
        archived: Boolean(group.archived)
      });
    }

    // 页面实体导入采用"最新标题覆盖"（与旧版导入行为一致：导入项各自携带最新标题）
    // 本地数据修订 8 起各分批事务同时生成 outbox 操作，保证导入数据也会同步到其他设备
    const enqueue = await SyncOutbox.isActive();
    const updateTitle = true;
    const pagesList = [...pageRecords.values()];

    for (const batch of IndexedDBManager.chunk(pagesList, WRITE_BATCH_SIZE)) {
      const stores = [IDBStores.PAGES];
      if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);
      await IndexedDBManager.runTransaction(stores, 'readwrite', async (tx) => {
        const store = tx.objectStore(IDBStores.PAGES);
        for (const page of batch) {
          const existing = await IndexedDBManager.requestToPromise(store.get(page.pageId));
          if (existing) {
            existing.favIconUrl = page.favIconUrl || existing.favIconUrl;
            existing.domain = page.domain || existing.domain;
            existing.updatedAt = page.updatedAt;
            if (updateTitle && page.title) existing.title = page.title;
            store.put(existing);
            if (enqueue) {
              await SyncOutbox.enqueueInTx(tx, {
                entityType: SyncEntityTypes.PAGE,
                entityId: existing.pageId,
                op: SyncOps.PATCH,
                fields: { favIconUrl: existing.favIconUrl, domain: existing.domain, title: existing.title, url: existing.url }
              });
            }
          } else {
            store.put(page);
            if (enqueue) {
              await SyncOutbox.enqueueInTx(tx, {
                entityType: SyncEntityTypes.PAGE,
                entityId: page.pageId,
                op: SyncOps.UPSERT,
                fields: { url: page.url, domain: page.domain, title: page.title, favIconUrl: page.favIconUrl, createdAt: page.createdAt }
              });
            }
          }
        }
      });
    }

    for (const batch of IndexedDBManager.chunk(entryRecords, WRITE_BATCH_SIZE)) {
      const stores = [IDBStores.STASH_ENTRIES];
      if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);
      await IndexedDBManager.runTransaction(stores, 'readwrite', async (tx) => {
        const store = tx.objectStore(IDBStores.STASH_ENTRIES);
        for (const record of batch) {
          store.put(record);
          if (enqueue) {
            await SyncOutbox.enqueueInTx(tx, {
              entityType: SyncEntityTypes.STASH_ENTRY,
              entityId: record.entryId,
              op: SyncOps.UPSERT,
              fields: {
                groupId: record.groupId,
                pageId: record.pageId,
                createdAt: record.createdAt,
                position: record.position,
                pinned: record.pinned,
                archived: record.archived
              }
            });
          }
        }
      });
    }

    for (const batch of IndexedDBManager.chunk(groupRecords, WRITE_BATCH_SIZE)) {
      const stores = [IDBStores.STASH_GROUPS];
      if (enqueue) stores.push(IDBStores.OUTBOX, IDBStores.SYNC_META, IDBStores.OPERATION_LOGS);
      await IndexedDBManager.runTransaction(stores, 'readwrite', async (tx) => {
        const store = tx.objectStore(IDBStores.STASH_GROUPS);
        for (const record of batch) {
          store.put(record);
          if (enqueue) {
            await SyncOutbox.enqueueInTx(tx, {
              entityType: SyncEntityTypes.STASH_GROUP,
              entityId: record.groupId,
              op: SyncOps.UPSERT,
              fields: {
                title: record.title,
                locked: record.locked,
                starred: record.starred,
                archived: record.archived,
                createdAt: record.createdAt
              }
            });
          }
        }
      });
    }
    if (enqueue) SyncOutbox.flushDirty();

    return { success: true, groupCount: groupRecords.length, entryCount: entryRecords.length };
  }
}
