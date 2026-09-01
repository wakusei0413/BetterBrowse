/**
 * @file sync-constants.js
 * @description WebDAV 云端同步协议常量（远端路径、状态枚举、配额与压缩阈值）
 * @encoding UTF-8
 */

/** WebDAV 远端清单、批次与快照的格式修订号 */
export const WEBDAV_FORMAT_REVISION = 1;

/** 同步元数据在 syncMeta 仓储中的主键 */
export const SYNC_CLOCK_KEY = 'clock';

/** 远端根目录名（拼在用户填写的 WebDAV 基址之后） */
export const SYNC_ROOT_DIR = 'BetterBrowse';

/** 同步状态机（选项页与引擎共用） */
export const SyncStatus = {
  IDLE: 'idle',
  SYNCED: 'synced',
  PENDING: 'pending',
  AUTH_FAILED: 'auth_failed',
  CAPABILITY_MISSING: 'capability_missing',
  CONFLICT: 'conflict',
  CORRUPT: 'corrupt',
  UNKNOWN: 'unknown'
};

/** 可同步实体类型 */
export const SyncEntityTypes = {
  PAGE: 'page',
  STASH_GROUP: 'stashGroup',
  STASH_ENTRY: 'stashEntry',
  SETTINGS: 'settings',
  LINK_RULES: 'linkRules',
  ACTIVITY: 'activity',
  DEVICE_EVENT: 'deviceEvent'
};

/** 操作类型 */
export const SyncOps = {
  UPSERT: 'upsert',
  PATCH: 'patch',
  DELETE: 'delete'
};

/** 墓碑回收期（毫秒） */
export const TOMBSTONE_TTL_MS = 30 * 86400000;

/** 设备自动退役阈值（毫秒） */
export const DEVICE_RETIRE_AFTER_MS = 90 * 86400000;

/** 快照推进：距上次至少 7 天 */
export const SNAPSHOT_MIN_AGE_MS = 7 * 86400000;

/** 快照推进：未压缩操作达到该条数也可生成 */
export const SNAPSHOT_MIN_OPS = 200;

/** 远端体积软上限 / 硬上限（字节） */
export const REMOTE_SOFT_QUOTA_BYTES = 50 * 1024 * 1024;
export const REMOTE_HARD_QUOTA_BYTES = 100 * 1024 * 1024;

/** 本地变更防抖（毫秒） */
export const SYNC_DEBOUNCE_MS = 3000;

/** 定时拉取间隔（分钟） */
export const SYNC_ALARM_MINUTES = 15;

/** 探测文件名（能力校验后删除） */
export const CAPABILITY_PROBE_NAME = '.bb-capability-probe';

/** 用户配置中允许进入同步的顶层标量键 */
export const SYNC_CONFIG_SCALAR_KEYS = [
  'tabThreshold',
  'autoThresholdNotify',
  'autoStashOnThreshold',
  'countdownSeconds',
  'thresholdCooldownMinutes',
  'recentActiveMinutes',
  'frequencyPercentile',
  'frequencyHistoryMinutes'
];

/** 用户配置中允许进入同步的嵌套对象键（按子字段展开） */
export const SYNC_CONFIG_NESTED_KEYS = [
  'rulesEnabled',
  'globalLinkRule',
  'stashSettings',
  'tieredStash',
  'autoBackupLimits',
  'webdavSync',
  'accountConfigSync'
];

/** 浏览器账号偏好镜像的格式修订号 */
export const ACCOUNT_CONFIG_FORMAT_REVISION = 1;

/**
 * chrome.storage.sync 单键配额为 8KB；序列化后超过该值则拒绝写入，
 * 给 Chrome 内部包装留余量。
 */
export const ACCOUNT_CONFIG_MAX_BYTES = 8000;
