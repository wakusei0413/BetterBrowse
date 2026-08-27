/**
 * @file storage-adapter.js
 * @description 统一存储适配器（支持 chrome.storage.local 与 sync，提供默认值合并及数据变更监听）
 * @encoding UTF-8
 */

import { StorageKeys } from '../../constants/storage-keys.js';
import { DefaultConfig, CURRENT_SCHEMA_VERSION } from '../../constants/config.js';

export class StorageAdapter {
  /**
   * 获取指定 Storage 区域（默认为 local，容量大且读写速度快）
   * @param {'local' | 'sync'} [area='local']
   */
  static getStorageArea(area = 'local') {
    if (area === 'session' && chrome.storage.session) return chrome.storage.session;
    if (area === 'sync' && chrome.storage.sync) return chrome.storage.sync;
    return chrome.storage.local;
  }

  /**
   * 读取存储值
   * @param {string} key - 存储键名
   * @param {any} [defaultValue=null] - 默认回退值
   * @param {'local' | 'sync'} [area='local'] - 存储区域
   * @returns {Promise<any>}
   */
  static async get(key, defaultValue = null, area = 'local') {
    return new Promise((resolve) => {
      try {
        const storage = this.getStorageArea(area);
        storage.get([key], (result) => {
          if (chrome.runtime.lastError) {
            console.error(`[StorageAdapter] 读取 key=${key} 失败:`, chrome.runtime.lastError);
            resolve(defaultValue);
            return;
          }
          const val = result ? result[key] : undefined;
          resolve(val !== undefined ? val : defaultValue);
        });
      } catch (err) {
        console.error(`[StorageAdapter] 读取异常 key=${key}:`, err);
        resolve(defaultValue);
      }
    });
  }

  /**
   * 写入存储值
   * @param {string} key - 存储键名
   * @param {any} value - 待存入的值
   * @param {'local' | 'sync'} [area='local'] - 存储区域
   * @returns {Promise<boolean>}
   */
  static async set(key, value, area = 'local') {
    return new Promise((resolve) => {
      try {
        const storage = this.getStorageArea(area);
        storage.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) {
            console.error(`[StorageAdapter] 写入 key=${key} 失败:`, chrome.runtime.lastError);
            resolve(false);
            return;
          }
          resolve(true);
        });
      } catch (err) {
        console.error(`[StorageAdapter] 写入异常 key=${key}:`, err);
        resolve(false);
      }
    });
  }

  /**
   * 批量获取多个键值
   * @param {string[]} keys - 键名列表
   * @param {'local' | 'sync'} [area='local']
   * @returns {Promise<Record<string, any>>}
   */
  static async getMultiple(keys, area = 'local') {
    return new Promise((resolve) => {
      const storage = this.getStorageArea(area);
      storage.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          console.error('[StorageAdapter] 批量读取失败:', chrome.runtime.lastError);
          resolve({});
          return;
        }
        resolve(result || {});
      });
    });
  }

  /**
   * 批量保存多个键值
   * @param {Record<string, any>} dataObject - 键值对对象
   * @param {'local' | 'sync'} [area='local']
   * @returns {Promise<boolean>}
   */
  static async setMultiple(dataObject, area = 'local') {
    return new Promise((resolve) => {
      const storage = this.getStorageArea(area);
      storage.set(dataObject, () => {
        if (chrome.runtime.lastError) {
          console.error('[StorageAdapter] 批量写入失败:', chrome.runtime.lastError);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  /**
   * 获取用户全局配置（自动与默认配置深度合并）
   * @returns {Promise<typeof DefaultConfig>}
   */
  static async getUserConfig() {
    const rawConfig = await this.get(StorageKeys.USER_CONFIG, {});
    const storedConfig = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
      ? rawConfig
      : {};
    return {
      ...DefaultConfig,
      ...storedConfig,
      rulesEnabled: {
        ...DefaultConfig.rulesEnabled,
        ...(storedConfig.rulesEnabled || {})
      },
      globalLinkRule: {
        ...DefaultConfig.globalLinkRule,
        ...(storedConfig.globalLinkRule || {})
      },
      stashSettings: {
        ...DefaultConfig.stashSettings,
        ...(storedConfig.stashSettings || {})
      },
      tieredStash: {
        ...DefaultConfig.tieredStash,
        ...(storedConfig.tieredStash || {})
      }
    };
  }

  /**
   * 更新用户全局配置
   * @param {Partial<typeof DefaultConfig>} partialConfig - 增量配置
   * @returns {Promise<boolean>}
   */
  static async updateUserConfig(partialConfig) {
    partialConfig = partialConfig && typeof partialConfig === 'object' && !Array.isArray(partialConfig)
      ? partialConfig
      : {};
    const current = await this.getUserConfig();
    const updated = {
      ...current,
      ...partialConfig,
      rulesEnabled: {
        ...current.rulesEnabled,
        ...(partialConfig.rulesEnabled || {})
      },
      globalLinkRule: {
        ...current.globalLinkRule,
        ...(partialConfig.globalLinkRule || {})
      },
      stashSettings: {
        ...current.stashSettings,
        ...(partialConfig.stashSettings || {})
      },
      tieredStash: {
        ...current.tieredStash,
        ...(partialConfig.tieredStash || {})
      }
    };
    return await this.set(StorageKeys.USER_CONFIG, updated);
  }

  /**
   * 监听存储变化事件
   * @param {(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void} callback
   */
  static addChangeListener(callback) {
    chrome.storage.onChanged.addListener(callback);
  }
}

