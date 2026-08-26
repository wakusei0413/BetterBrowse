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
  STASH_GROUPS: 'bb_stash_groups',           // 本地存储的收纳标签组列表
  ACTIVITY_STATS: 'bb_activity_stats',       // 标签页活跃度统计缓存
  THRESHOLD_STATE: 'bb_threshold_state',     // 阈值倒计时与冷却状态
  AUTO_BACKUPS: 'bb_auto_backups'            // 自动备份快照
};

