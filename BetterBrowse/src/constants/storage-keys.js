/**
 * @file storage-keys.js
 * @description 存储键名与命名空间定义
 * @encoding UTF-8
 */

export const StorageKeys = {
  SCHEMA_VERSION: 'bb_schema_version',       // 数据架构版本号
  USER_CONFIG: 'bb_user_config',             // 用户设置项配置
  LINK_RULES: 'bb_link_rules',               // 各域名链接跳转偏好字典 { [domain]: 'auto' | 'current' | 'new' }
  GLOBAL_LINK_RULE: 'bb_global_link_rule',   // 全局跳转规则配置 { enabled: boolean, mode: 'auto' | 'current' | 'new' }
  STASH_GROUPS: 'bb_stash_groups',           // 旧版收纳标签组数组（v5 起数据迁入 IndexedDB，保留 30 天作回退快照）
  ACTIVITY_STATS: 'bb_activity_stats',       // 标签页活跃度统计缓存
  THRESHOLD_STATE: 'bb_threshold_state',     // 阈值倒计时与冷却状态
  AUTO_BACKUPS: 'bb_auto_backups',           // 自动备份快照
  STASH_REV: 'bb_stash_revision',            // 收纳数据修订号（IndexedDB 模式下的跨上下文变更通知）
  IDB_MIGRATED_AT: 'bb_idb_migrated_at',     // IndexedDB 主库迁移完成时间戳（30 天旧数据保留期判定）
  IDB_OPTOUT: 'bb_idb_optout'                // 回退标记：置为 true 后数据源固定为 chrome.storage.local 旧存储
};

