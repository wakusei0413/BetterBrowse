/**
 * @file credentials.js
 * @description WebDAV 凭据本地仓储（仅 IndexedDB settings，永不进入 outbox / 快照 / 导出 JSON）
 * @encoding UTF-8
 */

import { StorageKeys } from '../../constants/storage-keys.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { IndexedDBManager, IDBStores } from '../storage/indexed-db.js';

export class WebdavCredentials {
  /**
   * 读取本地凭据（无记录时返回空对象）
   * @returns {Promise<{ serverUrl: string, username: string, password: string }>}
   */
  static async get() {
    try {
      const value = await StorageAdapter._getIdbValue(IDBStores.SETTINGS, StorageKeys.WEBDAV_CREDENTIALS);
      if (!value || typeof value !== 'object') {
        return { serverUrl: '', username: '', password: '' };
      }
      return {
        serverUrl: typeof value.serverUrl === 'string' ? value.serverUrl : '',
        username: typeof value.username === 'string' ? value.username : '',
        password: typeof value.password === 'string' ? value.password : ''
      };
    } catch {
      return { serverUrl: '', username: '', password: '' };
    }
  }

  /**
   * 保存凭据。必须在写锁内或由本方法自行持锁。
   * @param {{ serverUrl?: string, username?: string, password?: string }} partial
   * @returns {Promise<boolean>}
   */
  static async save(partial) {
    return await IndexedDBManager.withWriteLock(async () => {
      const current = await this.get();
      const next = {
        serverUrl: typeof partial?.serverUrl === 'string' ? partial.serverUrl.trim() : current.serverUrl,
        username: typeof partial?.username === 'string' ? partial.username : current.username,
        password: typeof partial?.password === 'string' ? partial.password : current.password
      };
      if (next.serverUrl && !/^https:\/\//i.test(next.serverUrl)) {
        throw new Error('WebDAV 地址必须使用 HTTPS');
      }
      return await StorageAdapter._setIdbValue(IDBStores.SETTINGS, StorageKeys.WEBDAV_CREDENTIALS, next);
    });
  }

  /**
   * 清除凭据
   * @returns {Promise<boolean>}
   */
  static async clear() {
    return await IndexedDBManager.withWriteLock(async () => {
      return await StorageAdapter._setIdbValue(IDBStores.SETTINGS, StorageKeys.WEBDAV_CREDENTIALS, {
        serverUrl: '',
        username: '',
        password: ''
      });
    });
  }
}
