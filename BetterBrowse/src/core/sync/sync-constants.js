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
  /** 服务器拒绝请求（HTTP 403）：权限不足或网盘限流，不一定是密码错误 */
  SERVER_REJECTED: 'server_rejected',
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

/** 两次自动同步的最小间隔：网盘 WebDAV 普遍限流，连续修改合并为一次同步 */
export const SYNC_MIN_INTERVAL_MS = 60000;

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

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 远端配置补丁的点分路径是否允许落地：只接受同步白名单内的标量键与嵌套键的一级子字段。
 * 远端载荷来自 WebDAV 服务器，可被伪造；放行任意路径会让远端打开 AI 桥接等设备本地开关，
 * 或经 __proto__ 污染 Service Worker 的原型链。
 * @param {string} path
 * @returns {boolean}
 */
export function isSyncableConfigPath(path) {
  if (typeof path !== 'string' || !path) return false;
  const parts = path.split('.');
  if (parts.some((part) => !part || UNSAFE_PATH_SEGMENTS.has(part))) return false;
  if (parts.length === 1) return SYNC_CONFIG_SCALAR_KEYS.includes(parts[0]);
  return parts.length === 2 && SYNC_CONFIG_NESTED_KEYS.includes(parts[0]) && parts[1] !== 'fieldRevs';
}

/**
 * 域名跳转规则条目是否合法（与备份恢复同一口径）
 * @param {string} domain
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isValidLinkRule(domain, mode) {
  return typeof domain === 'string'
    && /^[a-z0-9.-]+$/i.test(domain)
    && ['auto', 'current', 'new'].includes(String(mode));
}

/**
 * 从完整用户配置切出可同步部分（白名单键 + 对应字段版本），供快照生成与应用复用
 * @param {Record<string, any>} config
 * @returns {Record<string, any>}
 */
export function pickSyncableConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  const picked = {};
  for (const key of SYNC_CONFIG_SCALAR_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  for (const key of SYNC_CONFIG_NESTED_KEYS) {
    const nested = source[key];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const copy = {};
    for (const [sub, value] of Object.entries(nested)) {
      if (isSyncableConfigPath(`${key}.${sub}`)) copy[sub] = value;
    }
    picked[key] = copy;
  }
  const revs = source.fieldRevs && typeof source.fieldRevs === 'object' ? source.fieldRevs : {};
  picked.fieldRevs = {};
  for (const [path, rev] of Object.entries(revs)) {
    if (isSyncableConfigPath(path)) picked.fieldRevs[path] = rev;
  }
  return picked;
}

/** 浏览器账号偏好镜像的格式修订号 */
export const ACCOUNT_CONFIG_FORMAT_REVISION = 1;

/**
 * chrome.storage.sync 单键配额为 8KB；序列化后超过该值则拒绝写入，
 * 给 Chrome 内部包装留余量。
 */
export const ACCOUNT_CONFIG_MAX_BYTES = 8000;
