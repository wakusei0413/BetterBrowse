/**
 * @file ai-capabilities.js
 * @description AI 桥接能力自描述常量（动作目录、参数契约、确认位白名单；协议见 docs/03-ai-skill-bridge.md）
 *
 * 对等原则：AI Agent 经本机桥可调用的动作 = Service Worker 共享处理映射表中的全部动作，
 * 与人类 UI（弹窗 / 选项页 / 右键菜单）完全同一条处理路径。
 * 新增 handler 时必须同步在 ACTION_DOCS 中补充参数文档（parity 测试会校验覆盖）。
 * @encoding UTF-8
 */

import { API_VERSION } from '../../constants/api-version.js';
import { ActionTypes } from '../../constants/action-types.js';
import { LOCAL_DATA_SCHEMA_REVISION } from '../../constants/config.js';
import { FULL_BACKUP_FORMAT_REVISION } from '../../constants/format-revisions.js';
import { INDEXED_DB_SCHEMA_REVISION } from '../storage/indexed-db.js';
import { ACCOUNT_CONFIG_FORMAT_REVISION, WEBDAV_FORMAT_REVISION } from '../sync/sync-constants.js';

/** Native Messaging 宿主名（与 native-host 安装清单中的 name 一致） */
export const NATIVE_HOST_NAME = 'com.betterbrowse.bridge';

/**
 * 确认位白名单：镜像人类 UI 的不可逆操作确认弹窗。
 * AI 调用这些动作时 payload.confirm !== true 一律拒绝（不受"删除二次确认"设置影响，恒定要求）。
 * @type {Set<string>}
 */
export const AI_CONFIRM_REQUIRED_ACTIONS = new Set([
  ActionTypes.DELETE_STASH_GROUP,     // 删除收纳组（含 force 删锁定组）
  ActionTypes.CLEAR_ALL_STASH,        // 清空收纳数据
  ActionTypes.RESTORE_FULL_BACKUP,    // 恢复全量备份（覆盖配置与规则）
  ActionTypes.DEDUPLICATE_STASH_DATA, // 智能去重（删除重复组）
  ActionTypes.RESET_CONFIG,           // 恢复默认配置
  ActionTypes.RESTORE_AUTO_BACKUP,    // 恢复自动备份
  ActionTypes.DELETE_AUTO_BACKUP,     // 删除自动备份
  ActionTypes.CLEAR_RUNTIME_LOGS,      // 清空本地运行日志
  ActionTypes.REBUILD_SYNC_FROM_SCRATCH, // 从本机快照重建同步
  ActionTypes.RESTORE_STASH_GROUP_DATA // 恢复组快照（写入任意 URL 载荷）
]);

/**
 * 动作参数文档目录（summary 一句话用途；params 为参数名 → 类型与说明）
 * @type {Record<string, { summary: string, params?: Record<string, string>, note?: string }>}
 */
export const AI_ACTION_DOCS = {
  // === 链接跳转 ===
  [ActionTypes.GET_LINK_RULE]: {
    summary: '获取指定域名的链接跳转模式（含全局覆盖生效情况）',
    params: { domain: 'string，域名（可空，空时仅返回规则骨架）' }
  },
  [ActionTypes.SET_LINK_RULE]: {
    summary: '设置指定域名的链接跳转模式',
    params: { domain: 'string，域名', mode: "'auto' | 'current' | 'new'" }
  },
  [ActionTypes.GET_GLOBAL_LINK_RULE]: { summary: '读取全局链接跳转覆盖规则' },
  [ActionTypes.SET_GLOBAL_LINK_RULE]: {
    summary: '设置全局链接跳转覆盖规则',
    params: { enabled: 'boolean', mode: "'auto' | 'current' | 'new'" }
  },
  [ActionTypes.GET_DOMAIN_RULES]: { summary: '获取全部域名跳转规则字典' },
  [ActionTypes.SET_DOMAIN_RULE]: {
    summary: '设置（新增或修改）指定域名跳转规则',
    params: { domain: 'string，域名', mode: "'auto' | 'current' | 'new'" }
  },
  [ActionTypes.REMOVE_DOMAIN_RULE]: {
    summary: '删除指定域名跳转规则',
    params: { domain: 'string，域名' }
  },
  [ActionTypes.CLEAR_DOMAIN_RULES]: { summary: '清空全部域名跳转规则', note: '不可逆' },
  [ActionTypes.GET_PAGE_LINK_CONTEXT]: {
    summary: '获取页面跳转上下文（内容脚本专用，AI 调用时 sender 为空仅返回全局规则）'
  },
  [ActionTypes.OPEN_TAB_BACKGROUND]: {
    summary: '打开新标签页（仅 http/https；AI 调用时不绑定 opener）',
    params: { url: 'string，目标 URL', active: 'boolean，是否激活（缺省 true）' }
  },

  // === 智能收纳与规则 ===
  [ActionTypes.EVALUATE_TABS]: {
    summary: '只读评估当前所有标签页的收纳保留/收纳建议（P0~P3 规则）'
  },
  [ActionTypes.EXECUTE_STASH]: {
    summary: '执行智能收纳',
    params: { forceAll: 'boolean，缺省 true 全量收纳（与弹窗/收纳页按钮一致）' }
  },
  [ActionTypes.GET_TAB_ACTIVITY_STATS]: { summary: '获取标签页活跃度与频次统计快照' },
  [ActionTypes.GET_COUNTDOWN_STATUS]: { summary: '获取自动收纳倒计时运行状态' },
  [ActionTypes.CANCEL_AUTO_STASH]: { summary: '取消自动收纳倒计时（进入防打扰冷却）' },
  [ActionTypes.CONFIRM_AUTO_STASH]: { summary: '确认立即执行自动收纳（等价倒计时卡片"立即收纳"按钮）' },
  [ActionTypes.GET_TAB_COUNT_INFO]: { summary: '获取当前窗口可计数标签页数量与阈值' },

  // === 收纳箱数据管理 ===
  [ActionTypes.GET_STASH_GROUPS]: { summary: '获取全部收纳组（星标优先、时间倒序，含完整 tabs）' },
  [ActionTypes.GET_STASH_GROUP_SUMMARIES]: {
    summary: '获取收纳组摘要（兼容旧调用；新调用优先使用分页动作）',
    params: { previewLimit: 'number，缺省 0；兼容字段' }
  },
  [ActionTypes.GET_STASH_STATS]: { summary: '获取收纳组总数与条目总数' },
  [ActionTypes.GET_STASH_TIMELINE_BUCKETS]: {
    summary: '获取收纳时间线周分桶摘要，不返回组与条目实体'
  },
  [ActionTypes.GET_STASH_GROUP_SUMMARIES_PAGE]: {
    summary: '按稳定游标分页读取收纳组摘要',
    params: {
      cursor: 'string，可选；上一页返回的 nextCursor',
      limit: 'number，缺省 50，上限 200',
      createdAtFrom: 'number，可选，时间范围下界',
      createdAtTo: 'number，可选，时间范围上界'
    }
  },
  [ActionTypes.UPDATE_STASH_GROUP]: {
    summary: '更新收纳组属性',
    params: {
      groupId: 'string',
      updates: 'Partial<{ title: string, locked: boolean, starred: boolean, archived: boolean }>'
    }
  },
  [ActionTypes.RESTORE_STASH_GROUP]: {
    summary: '恢复整组标签页',
    params: {
      groupId: 'string',
      removeAfterRestore: 'boolean，恢复后是否删除该组（缺省按设置 restoreBehavior）'
    }
  },
  [ActionTypes.RESTORE_STASH_ITEM]: {
    summary: '恢复单个条目标签页',
    params: { groupId: 'string', itemId: 'string', removeAfterRestore: 'boolean（可选）' }
  },
  [ActionTypes.RESTORE_STASH_GROUP_DATA]: {
    summary: '恢复单组数据快照（幂等 upsert，仅写该组，不触碰配置；URL 经清洗）',
    params: { group: '快照组对象 { id, tabs[], title?, createdAt?, locked?, starred? }' },
    note: '需 confirm'
  },
  [ActionTypes.DELETE_STASH_GROUP]: {
    summary: '删除指定收纳组（锁定组需 updates.force 或 payload.force）',
    params: { groupId: 'string', force: 'boolean，强制删除锁定组' },
    note: '需 confirm'
  },
  [ActionTypes.DELETE_STASH_ITEM]: {
    summary: '删除组内单个条目',
    params: { groupId: 'string', itemId: 'string' }
  },
  [ActionTypes.CLEAR_ALL_STASH]: { summary: '清空收纳数据（保留锁定组）', note: '需 confirm' },
  [ActionTypes.DEDUPLICATE_STASH_DATA]: { summary: '清理 URL 完全相同的重复组', note: '需 confirm' },
  [ActionTypes.IMPORT_STASH_DATA]: {
    summary: '导入收纳数据 JSON（自动识别 OneTab 文本 / OneTab JSON / BetterBrowse JSON）',
    params: { jsonString: 'string，导入内容' }
  },
  [ActionTypes.EXPORT_STASH_DATA]: { summary: '导出收纳数据 JSON 字符串' },
  [ActionTypes.EXPORT_FULL_BACKUP]: {
    summary: '导出全量备份 JSON（兼容小数据完整响应；不含凭据与自动备份）'
  },
  [ActionTypes.READ_EXPORT_CHUNK]: {
    summary: '按无状态游标分块生成导出内容，适合大数据写文件',
    params: {
      type: "'full_backup' | 'stash_json' | 'onetab'",
      cursor: 'string，可选；上一块返回的 nextCursor',
      maxChars: 'number，单块字符上限',
      expectedStashRevision: 'number，可选；检测导出期间数据变化'
    }
  },
  [ActionTypes.RESTORE_FULL_BACKUP]: {
    summary: '恢复全量备份（配置走白名单恢复）',
    params: { jsonString: 'string，备份 JSON 文本' },
    note: '需 confirm'
  },
  [ActionTypes.IMPORT_THIRD_PARTY_DATA]: {
    summary: '从第三方工具导入（严格只导入标签组，不动设置）',
    params: { textString: 'string，OneTab 文本或 JSON' }
  },
  [ActionTypes.EXPORT_ONETAB_TEXT]: { summary: '导出 OneTab 兼容纯文本（URL | Title）' },

  // === 配置管理 ===
  [ActionTypes.GET_CONFIG]: { summary: '获取用户配置（与默认值深合并后的全量）' },
  [ActionTypes.UPDATE_CONFIG]: {
    summary: '增量更新配置（嵌套对象按字段合并）',
    params: { '<配置字段>': 'Partial<typeof DefaultConfig>，如 { tabThreshold: 20 }' }
  },
  [ActionTypes.RESET_CONFIG]: { summary: '恢复默认配置', note: '需 confirm' },

  // === 页面入口 ===
  [ActionTypes.OPEN_OPTIONS_PAGE]: {
    summary: '打开/激活选项页',
    params: { tab: "'stash' | 'stash-settings' | 'rules' | 'links' | 'backup' | 'sync' | 'ai-bridge' | 'logs'" }
  },
  [ActionTypes.OPEN_PINNED_STASH_TAB]: { summary: '打开并激活常驻首位的收纳箱页' },
  [ActionTypes.OPEN_ONE_TAB]: { summary: '打开常驻收纳箱页（兼容旧命名）' },

  // === 收纳条目与检索（AI 增强）===
  [ActionTypes.ADD_STASH_ITEM]: {
    summary: '向既有收纳组追加条目（URL 自动清洗，按 allowDuplicates 设置去重）',
    params: {
      groupId: 'string',
      item: '{ url: string, title?: string, favIconUrl?: string, pinned?: boolean }'
    }
  },
  [ActionTypes.UPDATE_STASH_ITEM]: {
    summary: '编辑收纳条目（title 为页面实体共享属性，同 URL 条目同步可见）',
    params: {
      groupId: 'string',
      itemId: 'string',
      updates: 'Partial<{ title: string, url: string, pinned: boolean, archived: boolean }>'
    }
  },
  [ActionTypes.SEARCH_STASH]: {
    summary: '按关键字游标检索收纳条目（标题 / URL 模糊匹配）',
    params: {
      keyword: 'string',
      limit: 'number，缺省 100',
      cursor: 'string，可选；上一页返回的 nextCursor',
      paginated: 'boolean，true 返回分页对象；缺省兼容返回数组'
    }
  },
  [ActionTypes.GET_STASH_GROUP_PAGE]: {
    summary: '使用数据库游标分页读取指定组条目',
    params: {
      groupId: 'string',
      cursor: 'string，可选；上一页返回的 nextCursor',
      offset: 'number，兼容旧调用，缺省 0',
      limit: 'number，缺省 50，上限 500'
    }
  },

  // === 自动备份管理（AI 增强）===
  [ActionTypes.LIST_AUTO_BACKUPS]: { summary: '列出自动备份快照摘要（时间、组数、条目数、体积）' },
  [ActionTypes.RESTORE_AUTO_BACKUP]: {
    summary: '恢复指定自动备份中的收纳组（幂等 upsert，不删除现有数据）',
    params: { createdAt: 'number，快照时间戳（来自 LIST_AUTO_BACKUPS）' },
    note: '需 confirm'
  },
  [ActionTypes.DELETE_AUTO_BACKUP]: {
    summary: '删除指定自动备份快照',
    params: { createdAt: 'number，快照时间戳' },
    note: '需 confirm'
  },

  // === WebDAV 云端同步 ===
  [ActionTypes.GET_SYNC_STATUS]: { summary: '获取同步状态（仅 hasPassword 布尔，凭据不可读）' },
  [ActionTypes.SAVE_WEBDAV_CREDENTIALS]: {
    summary: '保存 WebDAV 凭据（与人一致：只写不读，响应不含任何机密）',
    params: {
      serverUrl: 'string，HTTPS 地址',
      username: 'string',
      '密码字段（只写）': 'string，写入后任何接口均不可读回',
      enabled: 'boolean',
      autoSync: 'boolean'
    }
  },
  [ActionTypes.TEST_WEBDAV_CONNECTION]: { summary: '测试 WebDAV 连接（含兼容模式探测）' },
  [ActionTypes.RUN_SYNC_NOW]: { summary: '立即手动同步一次' },
  [ActionTypes.LIST_SYNC_CONFLICTS]: { summary: '列出同步冲突记录' },
  [ActionTypes.RESOLVE_SYNC_CONFLICT]: {
    summary: '裁决同步冲突',
    params: { conflictId: 'string', choice: "'local' | 'incoming'" }
  },
  [ActionTypes.LIST_SYNC_DEVICES]: { summary: '列出同步设备' },
  [ActionTypes.RETIRE_SYNC_DEVICE]: {
    summary: '退役指定同步设备',
    params: { deviceId: 'string' }
  },
  [ActionTypes.GET_SYNC_RECOVERY_INFO]: { summary: '读取同步损坏状态与本机快照可用性' },
  [ActionTypes.FALLBACK_PREVIOUS_SNAPSHOT]: { summary: '回退上一份远端或本机快照' },
  [ActionTypes.REBUILD_SYNC_FROM_SCRATCH]: {
    summary: '用本机已缓存快照整体替换可同步实体（不改远端清单）',
    note: '需 confirm'
  },

  // === 桥自身 ===
  [ActionTypes.GET_AI_CAPABILITIES]: { summary: '获取本能力清单（动作、参数、确认位要求与版本）' },
  [ActionTypes.GET_AI_BRIDGE_STATUS]: { summary: '获取桥接连接状态（选项页共用）' },
  [ActionTypes.QUERY_RUNTIME_LOGS]: {
    summary: '查询本机运行日志',
    params: { level: 'debug | info | warn | error（可选）', source: 'string（可选）', keyword: 'string（可选）', limit: 'number，最大 1000' }
  },
  [ActionTypes.CLEAR_RUNTIME_LOGS]: { summary: '清空本机运行日志', note: '需 confirm' }
};

/**
 * 构建能力自描述清单（GET_AI_CAPABILITIES 响应体）
 * availableActions 取自共享处理映射表的实际键集，保证"清单即事实"。
 * @param {{ softwareVersion?: string, availableActions?: string[] }} [options]
 * @returns {object}
 */
export function buildCapabilitiesDescriptor({ softwareVersion = '', availableActions = [] } = {}) {
  const available = new Set(availableActions);
  const actions = Object.keys(AI_ACTION_DOCS).map((action) => ({
    action,
    ...AI_ACTION_DOCS[action],
    available: available.size === 0 ? true : available.has(action)
  }));
  return {
    apiVersion: API_VERSION,
    softwareVersion,
    nativeHostName: NATIVE_HOST_NAME,
    product: 'BetterBrowse',
    internalRevisions: {
      localDataSchema: LOCAL_DATA_SCHEMA_REVISION,
      indexedDbSchema: INDEXED_DB_SCHEMA_REVISION,
      webdavFormat: WEBDAV_FORMAT_REVISION,
      accountConfigFormat: ACCOUNT_CONFIG_FORMAT_REVISION,
      fullBackupFormat: FULL_BACKUP_FORMAT_REVISION
    },
    confirmRequired: [...AI_CONFIRM_REQUIRED_ACTIONS],
    credentialPolicy: 'WebDAV 凭据只写不可读；任何响应不包含凭据字段',
    actions
  };
}
