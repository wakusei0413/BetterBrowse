/**
 * @file group-title.js
 * @description 收纳组时间与默认标题的统一格式（仓储、导入与界面共用）
 * @encoding UTF-8
 */

const STASH_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

/**
 * 格式化收纳时间（如 "2026/10/1 09:30"）
 * @param {number} timestamp
 * @returns {string}
 */
export function formatStashTime(timestamp) {
  return STASH_TIME_FORMAT.format(new Date(timestamp));
}

/**
 * 生成默认组标题（与历史数据格式保持一致）
 * @param {number} timestamp
 * @param {number} count
 * @returns {string}
 */
export function defaultGroupTitle(timestamp, count) {
  return `${formatStashTime(timestamp)} 收纳 (${count} 个标签页)`;
}
