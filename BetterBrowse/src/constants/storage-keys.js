/**
 * @file storage-keys.js
 * @description 存储键名与命名空间定义
 * @encoding UTF-8
 */

export const StorageKeys = {
  SCHEMA_VERSION: 'bb_schema_version',       // 本地数据架构修订号
  USER_CONFIG: 'bb_user_config',             // 用户设置项配置（本地数据修订 7 起权威数据在 IndexedDB settings）
  LINK_RULES: 'bb_link_rules',               // 各域名链接跳转偏好字典 { [domain]: 'auto' | 'current' | 'new' }（本地数据修订 7 起权威数据在 IndexedDB settings）
  STASH_GROUPS: 'bb_stash_groups',           // 旧版收纳标签组数组（本地数据修订 5 起数据迁入 IndexedDB，保留 30 天作回退快照）
  ACTIVITY_STATS: 'bb_activity_stats',       // 标签页活跃度统计缓存（本地数据修订 7 起权威数据在 IndexedDB activityStats）
  THRESHOLD_STATE: 'bb_threshold_state',     // 阈值倒计时与冷却状态（运行时状态，仍使用 chrome.storage.session）
  AUTO_BACKUPS: 'bb_auto_backups',           // 自动备份快照（本地数据修订 7 起权威数据在 IndexedDB settings）
  STASH_REV: 'bb_stash_revision',            // 收纳数据修订号（IndexedDB 模式下的跨上下文变更通知）
  IDB_MIGRATED_AT: 'bb_idb_migrated_at',     // IndexedDB 收纳主库迁移完成时间戳（30 天旧数据保留期判定）
  IDB_SETTINGS_MIGRATED_AT: 'bb_idb_settings_migrated_at', // IndexedDB 配置/规则/备份/活跃度迁移完成时间戳
  IDB_OPTOUT: 'bb_idb_optout',               // 回退标记：置为 true 后数据源固定为 chrome.storage.local 旧存储
  WEBDAV_CREDENTIALS: 'bb_webdav_credentials', // WebDAV 凭据（仅本地 IndexedDB settings，永不进入同步 / 导出 / 快照）
  ACCOUNT_CONFIG: 'bb_account_config',         // 浏览器账号偏好镜像（仅 chrome.storage.sync，不含收纳列表 / 域名表 / 凭据）
  AI_AUDIT_LOG: 'bb_ai_audit_log',             // 旧版 AI 审计日志（迁入统一运行日志后清空）
  DEVICE_EVENTS_LOG_MIGRATED: 'bb_device_events_log_migrated' // 旧跨设备动态迁入统一运行日志的本地标记
};

