/**
 * @file action-types.js
 * @description 统一消息通讯动作常量定义（强契约规范）
 * @encoding UTF-8
 */

export const ActionTypes = {
  // === 链接跳转相关 ===
  GET_LINK_RULE: 'GET_LINK_RULE',             // 获取当前域名的链接跳转规则
  SET_LINK_RULE: 'SET_LINK_RULE',             // 设置指定域名的链接跳转规则
  GET_GLOBAL_LINK_RULE: 'GET_GLOBAL_LINK_RULE', // 获取全局链接跳转规则
  SET_GLOBAL_LINK_RULE: 'SET_GLOBAL_LINK_RULE', // 设置全局链接跳转规则
  GET_DOMAIN_RULES: 'GET_DOMAIN_RULES',         // 获取全部域名跳转规则
  SET_DOMAIN_RULE: 'SET_DOMAIN_RULE',           // 设置指定域名跳转规则
  REMOVE_DOMAIN_RULE: 'REMOVE_DOMAIN_RULE',     // 删除指定域名跳转规则
  CLEAR_DOMAIN_RULES: 'CLEAR_DOMAIN_RULES',     // 清空全部域名跳转规则
  GET_PAGE_LINK_CONTEXT: 'GET_PAGE_LINK_CONTEXT', // 内容脚本获取当前页最小必要跳转上下文（禁止内容脚本直读存储）
  OPEN_TAB_BACKGROUND: 'OPEN_TAB_BACKGROUND', // 后台打开新标签页

  // === 智能收纳与规则相关 ===
  EVALUATE_TABS: 'EVALUATE_TABS',             // 评估当前所有标签页的收纳状态
  EXECUTE_STASH: 'EXECUTE_STASH',             // 执行智能标签页收纳
  GET_TAB_ACTIVITY_STATS: 'GET_TAB_ACTIVITY_STATS', // 获取标签页活跃度与频次统计
  CHECK_FORM_INPUT: 'CHECK_FORM_INPUT',       // 内容脚本检测表单输入状态
  SHOW_AUTO_STASH_COUNTDOWN: 'SHOW_AUTO_STASH_COUNTDOWN', // 向前台页面展示自动收纳倒计时弹窗
  HIDE_AUTO_STASH_COUNTDOWN: 'HIDE_AUTO_STASH_COUNTDOWN', // 广播隐藏/销毁前台倒计时弹窗
  GET_COUNTDOWN_STATUS: 'GET_COUNTDOWN_STATUS', // 获取当前后台倒计时运行状态
  CANCEL_AUTO_STASH: 'CANCEL_AUTO_STASH',     // 取消自动收纳倒计时（进入防打扰冷却）
  CONFIRM_AUTO_STASH: 'CONFIRM_AUTO_STASH',   // 确认执行自动收纳（倒计时归零或用户点击立即收纳）

  // === 收纳箱数据管理相关 ===
  GET_STASH_GROUPS: 'GET_STASH_GROUPS',       // 获取所有收纳标签组
  UPDATE_STASH_GROUP: 'UPDATE_STASH_GROUP',   // 更新标签组（重命名、锁定、星标）
  RESTORE_STASH_GROUP: 'RESTORE_STASH_GROUP', // 恢复指定的收纳标签组
  RESTORE_STASH_ITEM: 'RESTORE_STASH_ITEM',   // 恢复单个收纳标签项
  RESTORE_STASH_GROUP_DATA: 'RESTORE_STASH_GROUP_DATA', // 恢复单个收纳组数据快照（撤销删除专用：仅写入该组，不触碰现有组与配置）
  DELETE_STASH_GROUP: 'DELETE_STASH_GROUP',   // 删除指定的收纳标签组
  DELETE_STASH_ITEM: 'DELETE_STASH_ITEM',     // 删除单个收纳标签项
  CLEAR_ALL_STASH: 'CLEAR_ALL_STASH',         // 清空所有收纳数据
  DEDUPLICATE_STASH_DATA: 'DEDUPLICATE_STASH_DATA', // 清理重复收纳组
  IMPORT_STASH_DATA: 'IMPORT_STASH_DATA',     // 导入收纳数据（智能支持 OneTab 文本与 JSON）
  EXPORT_STASH_DATA: 'EXPORT_STASH_DATA',     // 导出收纳数据 (JSON)
  EXPORT_FULL_BACKUP: 'EXPORT_FULL_BACKUP',   // 导出全量备份 (含标签页 + 插件全局配置 + 域名规则)
  RESTORE_FULL_BACKUP: 'RESTORE_FULL_BACKUP', // 恢复全量备份 (还原标签页 + 插件全局配置 + 域名规则)
  IMPORT_THIRD_PARTY_DATA: 'IMPORT_THIRD_PARTY_DATA', // 从第三方工具导入标签页 (如 OneTab 文本/JSON)
  EXPORT_ONETAB_TEXT: 'EXPORT_ONETAB_TEXT',   // 导出为 OneTab 兼容纯文本 (URL | Title)

  // === 配置与状态同步相关 ===
  GET_CONFIG: 'GET_CONFIG',                   // 获取插件配置
  UPDATE_CONFIG: 'UPDATE_CONFIG',             // 更新插件配置
  RESET_CONFIG: 'RESET_CONFIG',               // 恢复默认配置
  GET_TAB_COUNT_INFO: 'GET_TAB_COUNT_INFO',   // 获取当前标签页数量及阈值信息
  OPEN_OPTIONS_PAGE: 'OPEN_OPTIONS_PAGE',     // 打开选项与收纳管理中心
  OPEN_PINNED_STASH_TAB: 'OPEN_PINNED_STASH_TAB', // 打开/激活常驻第1个位置的固定小标签页 (Pinned Tab)
  OPEN_ONE_TAB: 'OPEN_ONE_TAB',               // 打开外部 OneTab 页面

  // === 即时同步广播事件 ===
  NOTIFY_RULE_UPDATED: 'NOTIFY_RULE_UPDATED', // 广播通知各页面规则已变更，即时刷新内存
  NOTIFY_CONFIG_UPDATED: 'NOTIFY_CONFIG_UPDATED', // 广播通知各页面配置已变更
  NOTIFY_STASH_UPDATED: 'NOTIFY_STASH_UPDATED',   // 广播通知收纳数据已变更
  NOTIFY_SYNC_UPDATED: 'NOTIFY_SYNC_UPDATED',     // 广播云端同步状态变更

  // === WebDAV 云端同步 ===
  GET_SYNC_STATUS: 'GET_SYNC_STATUS',
  SAVE_WEBDAV_CREDENTIALS: 'SAVE_WEBDAV_CREDENTIALS',
  TEST_WEBDAV_CONNECTION: 'TEST_WEBDAV_CONNECTION',
  RUN_SYNC_NOW: 'RUN_SYNC_NOW',
  LIST_SYNC_CONFLICTS: 'LIST_SYNC_CONFLICTS',
  RESOLVE_SYNC_CONFLICT: 'RESOLVE_SYNC_CONFLICT',
  LIST_SYNC_DEVICES: 'LIST_SYNC_DEVICES',
  RETIRE_SYNC_DEVICE: 'RETIRE_SYNC_DEVICE',
  LIST_DEVICE_EVENTS: 'LIST_DEVICE_EVENTS',

  // === AI 桥接与增强读写（阶段三：人类 UI 与 AI Agent 共用同一处理路径）===
  ADD_STASH_ITEM: 'ADD_STASH_ITEM',           // 向既有收纳组添加条目（AI 增强：URL 自动清洗、按设置去重）
  UPDATE_STASH_ITEM: 'UPDATE_STASH_ITEM',     // 编辑收纳条目（标题/URL/置顶/归档；AI 增强）
  SEARCH_STASH: 'SEARCH_STASH',               // 按关键字全局检索收纳条目（AI 增强）
  GET_STASH_GROUP_PAGE: 'GET_STASH_GROUP_PAGE', // 组内条目分页读取（AI 增强，支撑超长组）
  LIST_AUTO_BACKUPS: 'LIST_AUTO_BACKUPS',     // 列出本地自动备份快照摘要（AI 增强）
  RESTORE_AUTO_BACKUP: 'RESTORE_AUTO_BACKUP', // 恢复指定自动备份中的收纳组（幂等 upsert，需 confirm）
  DELETE_AUTO_BACKUP: 'DELETE_AUTO_BACKUP',   // 删除指定自动备份快照（需 confirm）
  GET_AI_CAPABILITIES: 'GET_AI_CAPABILITIES', // AI 能力自描述清单（动作、参数、确认位要求与版本）
  GET_AI_BRIDGE_STATUS: 'GET_AI_BRIDGE_STATUS', // AI 桥接连接状态与最近操作审计（选项页与 AI 共用）
  CLEAR_AI_AUDIT_LOG: 'CLEAR_AI_AUDIT_LOG'    // 清空 AI 操作审计日志（选项页维护用）
};
