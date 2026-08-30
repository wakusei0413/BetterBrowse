/**
 * @file stash-badge.js
 * @description 扩展图标收纳计数徽章统一更新器（Service Worker 与阈值监控共用，保证所有写路径后 Badge 一致）
 * @encoding UTF-8
 */

import { StorageAdapter } from '../core/storage/storage-adapter.js';
import { LocalStashRepository } from '../core/stash/local-stash-repo.js';

/**
 * 按当前配置与收纳数据刷新扩展图标 Badge 计数
 * 用户关闭"显示标签计数"时清空 Badge；倒计时期间 ThresholdMonitor 会临时覆写，
 * 倒计时结束后必须调用本方法恢复计数。
 * @returns {Promise<void>}
 */
export async function updateStashBadge() {
  try {
    if (!chrome.action?.setBadgeText) return;
    const config = await StorageAdapter.getUserConfig();
    if (config.stashSettings?.showTabCountBadge === false) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const groups = await LocalStashRepository.getAllGroups();
    const count = groups.reduce((total, group) => total + (Array.isArray(group.tabs) ? group.tabs.length : 0), 0);
    await chrome.action.setBadgeText({ text: count > 999 ? '999+' : String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
  } catch (err) {
    // Badge 刷新失败不影响主流程
    console.warn('[StashBadge] 更新收纳计数徽章异常:', err);
  }
}
