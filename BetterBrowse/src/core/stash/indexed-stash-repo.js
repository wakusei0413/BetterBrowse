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

import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';

/** 单批次写入的最大记录数（避免单次大事务被 Service Worker 休眠打断） */
const WRITE_BATCH_SIZE = 500;

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
   * 统计收纳组数量（迁移完整性校验用）
   * @returns {Promise<number>}
   */
  static async countGroups() {
    return await IndexedDBManager.runTransaction([IDBStores.STASH_GROUPS], 'readonly', async (tx) => {
      return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.STASH_GROUPS).count());
    });
  }

  /**
   * 通过 pageId 索引精确查询一组 URL 是否已被任何收纳组收录（去重判定不加载整数组）
   * @param {string[]} urls - 待查询 URL 列表
   * @returns {Promise<Map<string, boolean>>} pageId -> 是否已存在
   */
  static async _queryExistingPageIds(urls) {
    const result = new Map();
    if (!urls || urls.length === 0) return result;
    await IndexedDBManager.runTransaction([IDBStores.STASH_ENTRIES], 'readonly', async (tx) => {
      const pageIndex = tx.objectStore(IDBStores.STASH_ENTRIES).index('pageId');
      for (const url of urls) {
        const pageId = this.computePageId(url);
        const entries = await IndexedDBManager.requestToPromise(pageIndex.getAll(pageId));
        result.set(pageId, entries.length > 0);
      }
    });
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
   * 分批写入页面实体（upsert 语义：已存在的页面按策略决定是否刷新标题）
   * @param {any[]} pageRecords - 页面实体记录
   * @param {boolean} updateTitle - 已存在页面是否用最新标题覆盖（对应 useLatest 行为）
   */
  static async _upsertPages(pageRecords, updateTitle) {
    for (const batch of IndexedDBManager.chunk(pageRecords, WRITE_BATCH_SIZE)) {
      await IndexedDBManager.runTransaction([IDBStores.PAGES], 'readwrite', async (tx) => {
        const store = tx.objectStore(IDBStores.PAGES);
        for (const page of batch) {
          const existing = await IndexedDBManager.requestToPromise(store.get(page.pageId));
          if (existing) {
            // 同一 URL 复用页面实体，仅刷新动态字段
            existing.favIconUrl = page.favIconUrl || existing.favIconUrl;
            existing.domain = page.domain || existing.domain;
            existing.updatedAt = page.updatedAt;
            if (updateTitle && page.title) existing.title = page.title;
            store.put(existing);
          } else {
            store.put(page);
          }
        }
      });
    }
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

    const groupRecord = {
      groupId,
      createdAt: now,
      title: defaultTitle,
      locked: false,
      starred: false,
      archived: false
    };

    // 1. 页面实体（同一 URL 复用已有实体）
    await this._upsertPages([...pagesById.values()], updateTitle);
    // 2. 收纳记录
    await this._putChunked(IDBStores.STASH_ENTRIES, entryRecords);
    // 3. 组记录（最后写入，中断时上层不可见半成品）
    await this._putChunked(IDBStores.STASH_GROUPS, [groupRecord]);

    // 返回与旧版结构完全一致的组对象（entryId 已含组命名空间，跨组唯一）
    return {
      success: true,
      group: {
        id: groupId,
        createdAt: now,
        title: defaultTitle,
        locked: false,
        starred: false,
        archived: false,
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
    return await IndexedDBManager.runTransaction([IDBStores.STASH_GROUPS], 'readwrite', async (tx) => {
      const store = tx.objectStore(IDBStores.STASH_GROUPS);
      const existing = await IndexedDBManager.requestToPromise(store.get(groupId));
      if (!existing || !updates || typeof updates !== 'object') return false;
      const allowed = ['title', 'locked', 'starred', 'archived'];
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
          existing[key] = key === 'title' ? String(updates[key]).slice(0, 200) : Boolean(updates[key]);
        }
      }
      store.put(existing);
      return true;
    });
  }

  /**
   * 删除指定收纳组及其全部收纳记录（不删除页面实体，供后续同 URL 复用）
   * ⚠️ 调用方必须已持有跨上下文写锁
   * @param {string} groupId
   * @param {boolean} [force=false] - 锁定组是否强制删除
   * @returns {Promise<boolean>}
   */
  static async _deleteGroupUnlocked(groupId, force = false) {
    return await IndexedDBManager.runTransaction(
      [IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES],
      'readwrite',
      async (tx) => {
        const groupsStore = tx.objectStore(IDBStores.STASH_GROUPS);
        const entriesStore = tx.objectStore(IDBStores.STASH_ENTRIES);
        const group = await IndexedDBManager.requestToPromise(groupsStore.get(groupId));
        if (!group) return true; // 组不存在视为已删除（与旧版语义一致）
        if (group.locked && !force) return false;
        groupsStore.delete(groupId);
        const entries = await IndexedDBManager.requestToPromise(
          entriesStore.index('groupId').getAll(groupId)
        );
        for (const entry of entries) entriesStore.delete(entry.entryId);
        return true;
      }
    );
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
    return await IndexedDBManager.runTransaction(
      [IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES],
      'readwrite',
      async (tx) => {
        const groupsStore = tx.objectStore(IDBStores.STASH_GROUPS);
        const entriesStore = tx.objectStore(IDBStores.STASH_ENTRIES);
        const group = await IndexedDBManager.requestToPromise(groupsStore.get(groupId));
        if (!group) return false;

        const entries = await IndexedDBManager.requestToPromise(
          entriesStore.index('groupId').getAll(groupId)
        );
        const remaining = entries.filter((entry) => entry.entryId !== itemId);
        if (remaining.length === entries.length) {
          // 条目不存在：与旧版一致，仍视为成功
          return true;
        }
        entriesStore.delete(itemId);
        if (remaining.length === 0 && !group.locked) {
          groupsStore.delete(groupId);
        }
        return true;
      }
    );
  }

  /**
   * 清空所有非锁定的收纳组（includeLocked 为 true 时连同锁定组一并清空）
   * ⚠️ 调用方必须已持有跨上下文写锁
   * @param {boolean} [includeLocked=false]
   * @returns {Promise<boolean>}
   */
  static async clearAll(includeLocked = false) {
    return await IndexedDBManager.runTransaction(
      [IDBStores.STASH_GROUPS, IDBStores.STASH_ENTRIES],
      'readwrite',
      async (tx) => {
        const groupsStore = tx.objectStore(IDBStores.STASH_GROUPS);
        const entriesStore = tx.objectStore(IDBStores.STASH_ENTRIES);
        if (includeLocked) {
          groupsStore.clear();
          entriesStore.clear();
          return true;
        }
        const groups = await IndexedDBManager.requestToPromise(groupsStore.getAll());
        for (const group of groups) {
          if (group.locked) continue;
          groupsStore.delete(group.groupId);
          const entries = await IndexedDBManager.requestToPromise(
            entriesStore.index('groupId').getAll(group.groupId)
          );
          for (const entry of entries) entriesStore.delete(entry.entryId);
        }
        return true;
      }
    );
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
  static async getGroupPage(groupId, { offset = 0, limit = 50 } = {}) {
    return await IndexedDBManager.runTransaction(
      [IDBStores.STASH_ENTRIES, IDBStores.PAGES],
      'readonly',
      async (tx) => {
        const entries = await IndexedDBManager.requestToPromise(
          tx.objectStore(IDBStores.STASH_ENTRIES).index('groupId').getAll(groupId)
        );
        entries.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const slice = entries.slice(offset, offset + limit);
        const pagesStore = tx.objectStore(IDBStores.PAGES);
        const items = [];
        for (const entry of slice) {
          const page = await IndexedDBManager.requestToPromise(pagesStore.get(entry.pageId));
          items.push({
            id: entry.entryId,
            url: page?.url || '',
            title: page?.title || page?.url || '无标题页面',
            favIconUrl: page?.favIconUrl || '',
            pinned: Boolean(entry.pinned)
          });
        }
        return { items, total: entries.length, offset, limit };
      }
    );
  }

  /**
   * 按关键字检索页面实体（标题 / URL 模糊匹配，命中后经 pageId 索引定位收纳记录）
   * @param {string} keyword
   * @param {{ limit?: number }} [options]
   * @returns {Promise<Array<{ groupId: string, itemId: string, url: string, title: string }>>}
   */
  static async searchEntries(keyword, { limit = 100 } = {}) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return [];
    return await IndexedDBManager.runTransaction(
      [IDBStores.PAGES, IDBStores.STASH_ENTRIES],
      'readonly',
      async (tx) => {
        const pages = await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.PAGES).getAll());
        const matched = pages
          .filter(
            (page) =>
              String(page.title || '').toLowerCase().includes(kw) ||
              String(page.url || '').toLowerCase().includes(kw)
          )
          .slice(0, limit);
        if (matched.length === 0) return [];

        const entryIndex = tx.objectStore(IDBStores.STASH_ENTRIES).index('pageId');
        const results = [];
        for (const page of matched) {
          const entries = await IndexedDBManager.requestToPromise(entryIndex.getAll(page.pageId));
          for (const entry of entries) {
            results.push({
              groupId: entry.groupId,
              itemId: entry.entryId,
              url: page.url,
              title: page.title
            });
          }
        }
        return results.slice(0, limit);
      }
    );
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
        // 缺失 id 的脏数据用确定性指纹兜底，避免重跑产生随机重复
        const tabKey = tab.id || `t_${this.computePageId(`${group.id}::${position}::${tab.url}`)}`;
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
        locked: Boolean(group.locked),
        starred: Boolean(group.starred),
        archived: Boolean(group.archived)
      });
    }

    // 页面实体导入采用"最新标题覆盖"（与旧版导入行为一致：导入项各自携带最新标题）
    await this._upsertPages([...pageRecords.values()], true);
    await this._putChunked(IDBStores.STASH_ENTRIES, entryRecords);
    await this._putChunked(IDBStores.STASH_GROUPS, groupRecords);

    return { success: true, groupCount: groupRecords.length, entryCount: entryRecords.length };
  }
}
