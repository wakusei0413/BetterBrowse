/**
 * @file runtime-log-repository.js
 * @description 统一运行日志仓储（本地 IndexedDB 环形保留、筛选与清理）
 * @encoding UTF-8
 */

import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';

export const RUNTIME_LOG_LIMIT = 1000;
const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const VALID_CATEGORIES = new Set(['runtime', 'audit']);

function createLogId(ts) {
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `${ts}-${random}`;
}

function normalizeText(value, fallback, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, maxLength);
}

export class RuntimeLogRepository {
  static _writeQueue = Promise.resolve();

  static normalize(entry = {}) {
    const ts = Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : Date.now();
    return {
      id: normalizeText(entry.id, createLogId(ts), 160),
      ts,
      level: VALID_LEVELS.has(entry.level) ? entry.level : 'info',
      source: normalizeText(entry.source, 'BetterBrowse', 80),
      context: normalizeText(entry.context, 'background', 40),
      category: VALID_CATEGORIES.has(entry.category) ? entry.category : 'runtime',
      message: normalizeText(entry.message, '-', 4000)
    };
  }

  static append(entry) {
    const record = this.normalize(entry);
    const run = async () => {
      await IndexedDBManager.withWriteLock(async () => {
        await IndexedDBManager.runTransaction(IDBStores.RUNTIME_LOGS, 'readwrite', async (tx) => {
          const store = tx.objectStore(IDBStores.RUNTIME_LOGS);
          await IndexedDBManager.requestToPromise(store.put(record));
          const count = await IndexedDBManager.requestToPromise(store.count());
          if (count <= RUNTIME_LOG_LIMIT) return;
          const all = await IndexedDBManager.requestToPromise(store.getAll());
          all.sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
          for (const stale of all.slice(0, all.length - RUNTIME_LOG_LIMIT)) {
            await IndexedDBManager.requestToPromise(store.delete(stale.id));
          }
        });
      });
      return record;
    };
    const result = this._writeQueue.then(run, run);
    this._writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  static async query({ level = '', source = '', keyword = '', category = '', limit = 200 } = {}) {
    await this._writeQueue;
    const all = await IndexedDBManager.runTransaction(IDBStores.RUNTIME_LOGS, 'readonly', async (tx) => {
      return await IndexedDBManager.requestToPromise(tx.objectStore(IDBStores.RUNTIME_LOGS).getAll());
    });
    const normalizedKeyword = String(keyword || '').trim().toLocaleLowerCase();
    const normalizedSource = String(source || '').trim().toLocaleLowerCase();
    const max = Math.min(RUNTIME_LOG_LIMIT, Math.max(1, Math.floor(Number(limit) || 200)));
    const filtered = all
      .filter((entry) => !level || entry.level === level)
      .filter((entry) => !category || entry.category === category)
      .filter((entry) => !normalizedSource || String(entry.source).toLocaleLowerCase() === normalizedSource)
      .filter((entry) => {
        if (!normalizedKeyword) return true;
        return `${entry.source} ${entry.message}`.toLocaleLowerCase().includes(normalizedKeyword);
      })
      .sort((a, b) => b.ts - a.ts || String(b.id).localeCompare(String(a.id)));
    return {
      entries: filtered.slice(0, max),
      total: filtered.length,
      sources: [...new Set(all.map((entry) => entry.source).filter(Boolean))].sort((a, b) => a.localeCompare(b))
    };
  }

  static async clear({ category = '' } = {}) {
    await this._writeQueue;
    await IndexedDBManager.withWriteLock(async () => {
      await IndexedDBManager.runTransaction(IDBStores.RUNTIME_LOGS, 'readwrite', async (tx) => {
        const store = tx.objectStore(IDBStores.RUNTIME_LOGS);
        if (!category) {
          await IndexedDBManager.requestToPromise(store.clear());
          return;
        }
        const all = await IndexedDBManager.requestToPromise(store.getAll());
        for (const entry of all) {
          if (entry.category === category) {
            await IndexedDBManager.requestToPromise(store.delete(entry.id));
          }
        }
      });
    });
    return { success: true };
  }
}
