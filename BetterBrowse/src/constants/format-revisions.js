/**
 * @file format-revisions.js
 * @description 不属于统一 API 版本的内部持久化格式修订号
 * @encoding UTF-8
 */

/**
 * BetterBrowse 全量备份格式修订号（持久化字段继续使用 version 以兼容既有备份）。
 * 仅当备份 JSON 的持久化结构发生不兼容变化时递增；UI 或软件发布不应修改它。
 */
export const FULL_BACKUP_FORMAT_REVISION = 1;
