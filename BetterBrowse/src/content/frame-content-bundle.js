/**
 * @file frame-content-bundle.js
 * @description BetterBrowse iframe 轻量内容脚本打包产物
 * @encoding UTF-8
 * @betterbrowse-sources src/constants/action-types.js=713fa0a0;src/constants/config.js=94245c84;src/core/link/link-matcher.js=25202d73;src/content/form-detector.js=ac1a1c56;src/content/link-interceptor.js=1242386c;src/content/frame-index.js=ecaaf4df
 */
(function() {
  'use strict';
  if (window.top === window.self || window.__BETTER_BROWSE_FRAME_BUNDLE_LOADED__) return;
  window.__BETTER_BROWSE_FRAME_BUNDLE_LOADED__ = true;

// ===== [模块: src/constants/action-types.js] =====
/**
 * @file action-types.js
 * @description 统一消息通讯动作常量定义（强契约规范）
 * @encoding UTF-8
 */

const ActionTypes = {
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
  GET_STASH_GROUPS: 'GET_STASH_GROUPS',       // 获取所有收纳标签组（含完整 tabs，导出/AI 全量通道）
  GET_STASH_GROUP_SUMMARIES: 'GET_STASH_GROUP_SUMMARIES', // 获取收纳组摘要（兼容旧调用）
  GET_STASH_STATS: 'GET_STASH_STATS',         // 获取收纳组与条目总数
  GET_STASH_TIMELINE_BUCKETS: 'GET_STASH_TIMELINE_BUCKETS', // 获取时间线分桶摘要
  GET_STASH_GROUP_SUMMARIES_PAGE: 'GET_STASH_GROUP_SUMMARIES_PAGE', // 游标分页读取收纳组摘要
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
  READ_EXPORT_CHUNK: 'READ_EXPORT_CHUNK',     // 按游标分块生成导出内容，避免构造完整响应
  RESTORE_FULL_BACKUP: 'RESTORE_FULL_BACKUP', // 恢复全量备份 (还原标签页 + 插件全局配置 + 域名规则)
  IMPORT_THIRD_PARTY_DATA: 'IMPORT_THIRD_PARTY_DATA', // 从第三方工具导入标签页 (如 OneTab 文本/JSON)
  EXPORT_ONETAB_TEXT: 'EXPORT_ONETAB_TEXT',   // 导出为 OneTab 兼容纯文本 (URL | Title)
  RESOLVE_FAVICON_DATA_URL: 'RESOLVE_FAVICON_DATA_URL', // 后台代取站点图标并转为 data URL，避免扩展页直连第三方触发 PNA/CORS 与归档历史泄露

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

  // === AI 桥接与增强读写（阶段三：人类 UI 与 AI Agent 共用同一处理路径）===
  ADD_STASH_ITEM: 'ADD_STASH_ITEM',           // 向既有收纳组添加条目（AI 增强：URL 自动清洗、按设置去重）
  UPDATE_STASH_ITEM: 'UPDATE_STASH_ITEM',     // 编辑收纳条目（标题/URL/置顶/归档；AI 增强）
  SEARCH_STASH: 'SEARCH_STASH',               // 按关键字全局检索收纳条目（AI 增强）
  GET_STASH_GROUP_PAGE: 'GET_STASH_GROUP_PAGE', // 组内条目分页读取（AI 增强，支撑超长组）
  LIST_AUTO_BACKUPS: 'LIST_AUTO_BACKUPS',     // 列出本地自动备份快照摘要（AI 增强）
  RESTORE_AUTO_BACKUP: 'RESTORE_AUTO_BACKUP', // 恢复指定自动备份中的收纳组（幂等 upsert，需 confirm）
  DELETE_AUTO_BACKUP: 'DELETE_AUTO_BACKUP',   // 删除指定自动备份快照（需 confirm）
  GET_AI_CAPABILITIES: 'GET_AI_CAPABILITIES', // AI 能力自描述清单（动作、参数、确认位要求与版本）
  GET_AI_BRIDGE_STATUS: 'GET_AI_BRIDGE_STATUS', // AI 桥接连接状态（选项页与 AI 共用）

  // === 统一运行日志 ===
  APPEND_RUNTIME_LOG: 'APPEND_RUNTIME_LOG',      // 扩展内部上下文向后台追加运行日志（不暴露给 AI）
  QUERY_RUNTIME_LOGS: 'QUERY_RUNTIME_LOGS',      // 查询本地运行日志
  CLEAR_RUNTIME_LOGS: 'CLEAR_RUNTIME_LOGS',      // 清空本地运行日志（需 confirm）

  // === 云端同步损坏恢复 ===
  GET_SYNC_RECOVERY_INFO: 'GET_SYNC_RECOVERY_INFO',         // 读取损坏状态与本机快照可用性
  FALLBACK_PREVIOUS_SNAPSHOT: 'FALLBACK_PREVIOUS_SNAPSHOT', // 回退上一份远端/本地快照
  REBUILD_SYNC_FROM_SCRATCH: 'REBUILD_SYNC_FROM_SCRATCH',   // 从本机快照重建同步 { confirm: true }

  // === 主页与新标签页 ===
  GET_SEARCH_SUGGESTIONS: 'GET_SEARCH_SUGGESTIONS',         // 获取搜索引擎联想建议（Google/Bing，需主动同意）
  GET_BROWSER_HISTORY: 'GET_BROWSER_HISTORY',               // 搜索本地浏览历史（需 optional history 权限）
  GET_HISTORY_RECOMMENDATIONS: 'GET_HISTORY_RECOMMENDATIONS', // 获取历史推荐（最近/常访，标注候选范围和visitCount）
  GET_HOME_STATS: 'GET_HOME_STATS',                         // 获取主页统计（当前窗口标签/阈值/收纳总计）
  CHECK_HISTORY_PERMISSION: 'CHECK_HISTORY_PERMISSION'       // 检查 optional history 权限真实状态
};


// ===== [模块: src/constants/config.js] =====
/**
 * @file config.js
 * @description 默认配置与业务常量定义
 * @encoding UTF-8
 */

const LinkModes = {
  AUTO: 'auto',       // 🔄 自动模式（遵循网站原本行为）
  CURRENT: 'current', // ⬅️ 当前标签页打开
  NEW: 'new'          // ➡️ 新标签页打开
};

const RulePriorities = {
  P0: 0, // 最高优先级（媒体播放、表单输入中）
  P1: 1, // 高优先级（最近访问）
  P2: 2, // 中优先级（高使用频率）
  P3: 3  // 低优先级（固定标签页）
};

const DefaultConfig = {
  // === 标签页收纳阈值与触发配置 ===
  tabThreshold: 15,              // 触发自动收纳提示的标签页数量阈值
  autoThresholdNotify: true,     // 达到阈值时是否弹出通知提醒
  autoStashOnThreshold: true,    // 达到阈值时是否自动倒计时智能收纳
  countdownSeconds: 15,          // 自动收纳倒计时时长（秒，默认15秒）
  thresholdCooldownMinutes: 5,   // 取消或触发后的防打扰冷却时间（分钟，默认5分钟）
  recentActiveMinutes: 5,        // "最近访问"时间窗口（分钟，默认5分钟）
  frequencyPercentile: 0.2,      // "高频使用"保留比例（前20%）
  frequencyHistoryMinutes: 60,   // 统计使用频次的时间窗口（分钟，默认60分钟）

  // === 规则启用开关 ===
  rulesEnabled: {
    audible: true,    // P0: 保护正在播放音频/视频的标签页
    formGuard: true,  // P0: 保护正在输入表单的标签页
    recentActive: true,// P1: 保护最近访问的标签页
    highFrequency: true,// P2: 保护高频访问的标签页
    pinned: true      // P3: 保护固定在左侧的标签页
  },

  // === 全局链接跳转覆盖默认设置 ===
  globalLinkRule: {
    enabled: false,             // 是否开启全局覆盖
    mode: LinkModes.AUTO        // 全局默认跳转模式
  },

  // === 收纳箱精细化设置 ===
  stashSettings: {
    restoreBehavior: 'remove',
    restorePosition: 'currentWindow',
    allowDuplicates: true,
    existingTabTitleBehavior: 'useOriginal',
    autoOpenStashTab: true,
    pinnedTabGuard: true,
    deleteConfirmation: true,
    excludePinnedTabs: true,
    excludeAudibleTabs: true,
    excludeFormDirtyTabs: true,
    autoBackupEnabled: true,
    backupRetentionDays: 30,
    displayDensity: 'comfortable'
  },

  // === 本地自动快照安全约束 ===
  // 防止收纳数据过多时自动备份撑爆 chrome.storage.local 配额（默认约 5MB）
  autoBackupLimits: {
    maxBackups: 2,              // 最多保留几份快照（新 + 旧）
    maxTotalBytes: 3 * 1024 * 1024, // 自动备份总大小软上限（字节，留余量给其它数据）
    stripFavIcons: true         // 快照中剔除 favIconUrl 以显著减小体积
  },

  // === WebDAV 云端同步（非机密项；密码见 bb_webdav_credentials）===
  webdavSync: {
    enabled: false,
    autoSync: true,
    serverUrl: ''
  },

  // === 浏览器账号偏好同步（chrome.storage.sync；不含收纳列表 / 域名表 / 凭据）===
  accountConfigSync: {
    enabled: true             // 同品牌、已登录账号的设备之间镜像阈值与规则等偏好
  },

  // === AI 桥接（阶段三：本机 AI Agent 经 Native Messaging 与人类能力对等操控插件）===
  // 设备本地偏好：不进入 chrome.storage.sync 账号镜像、不进入 WebDAV 同步与任何导出
  aiBridge: {
    enabled: false           // 总开关（默认关闭）：开启后扩展按需拉起本机宿主并接受 Agent 指令
  },

  // === 阶梯式降级收纳（Tiered Escalation Stash）===
  // 当一轮智能收纳后标签页数量仍超过阈值时，逐级放宽"软性保护"
  // （最近访问窗口逐级缩短、高频访问门槛逐级提高），直至降到阈值以下。
  tieredStash: {
    enabled: true,            // 总开关：是否启用阶梯式降级收纳
    maxTiers: 5,              // 最大降级层数（0 = 不降级，仅执行标准一轮）
    tierStepSeconds: 60,      // 每级将"最近访问"保护窗口缩短的秒数（默认 60 秒/级）
    ultimateFallback: true,   // 终极兜底：软性保护全部放宽后仍超标时，按重要度从低到高强制回收
    targetSafetyMargin: 0     // 达标安全余量：降到阈值以下后再额外多收纳的标签页数量
  },

  // === 主页与新标签页偏好配置（保持本地，不进入跨设备同步）===
  home: {
    searchEngine: 'google',           // 默认主搜索引擎: 'google' | 'bing' | 'baidu' | 'duckduckgo'
    enableExternalSuggest: false,     // 外部联想建议总开关（默认关闭，需要主动同意）
    suggestEngine: 'google',          // 联想建议服务源: 'google' | 'bing'
    externalSuggestAgreed: false,     // 是否已明确主动同意向第三方外部引擎发送输入内容（本地敏感项，不导出、不同步）
    showRecentStash: true,            // 是否在主页展示近期收纳
    showHistoryRecommendations: true, // 是否在主页展示历史记录推荐（需 optional 权限）
    showWindowTabStats: true          // 是否在主页展示当前窗口标签/阈值/收纳统计
  }
};

// 本地数据修订 5：收纳组数据迁移至 IndexedDB 本地主库（页面实体 + 收纳记录两层模型）
// 本地数据修订 6：修复历史恢复操作产生的双前缀重复条目并清理孤儿条目（见 MigrationManager.repairIndexedEntries）
// 本地数据修订 7：配置、链接规则、活动统计与自动备份迁入 IndexedDB（阶段一 M2 全量）
// 本地数据修订 8：WebDAV 同步仓储、按 pageId 的活跃度、实体同步元数据（阶段二 M3）
// 本地数据修订 9：回填收纳组派生字段 itemCount / starRank / nextPosition，供真分页摘要使用
// 本地数据修订 10：活跃度按 pageId 分记录持久化，避免每次激活整对象重写
const LOCAL_DATA_SCHEMA_REVISION = 10;


// ===== [模块: src/core/link/link-matcher.js] =====
/**
 * @file link-matcher.js
 * @description 链接与域名匹配器（提供主机名提取、有效跳转模式判定、子域名匹配及特殊协议过滤）
 * @encoding UTF-8
 */



class LinkMatcher {
  /**
   * 从 URL 中安全提取规范化域名（小写，不带端口号与协议）
   * @param {string} rawUrl - 原始链接
   * @returns {string} 提取的主机名（如 "github.com"），若无法解析则返回空字符串
   */
  static extractDomain(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      // 过滤特殊非 HTTP/HTTPS 协议（例如 chrome://, javascript:, mailto:）
      if (!/^https?:\/\//i.test(rawUrl)) {
        if (rawUrl.startsWith('//')) {
          rawUrl = 'https:' + rawUrl;
        } else {
          return '';
        }
      }
      const parsed = new URL(rawUrl);
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * 检查 URL 是否为可进行跳转拦截的合法网页
   * @param {string} url - 目标链接
   * @returns {boolean}
   */
  static isInterceptionAllowed(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed || trimmed === '#' || trimmed.startsWith('#') || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
    const protocolMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
    return !protocolMatch || /^https?:$/i.test(`${protocolMatch[1]}:`);
  }

  /**
   * 根据当前域名设置与全局规则，计算当前链接最终生效的跳转模式（支持智能子域名匹配）
   * @param {Object} params
   * @param {string} params.domain - 当前页面域名
   * @param {Record<string, string>} params.linkRules - 域名规则字典
   * @param {{ enabled: boolean, mode: string }} params.globalLinkRule - 全局规则配置
   * @returns {'auto' | 'current' | 'new'} 最终生效模式
   */
  static resolveEffectiveMode({ domain, linkRules = {}, globalLinkRule = {} }) {
    // 1. 若开启了“对所有网站生效”全局覆盖开关，则直接优先使用全局模式
    if (globalLinkRule && globalLinkRule.enabled && globalLinkRule.mode) {
      return globalLinkRule.mode;
    }

    if (!domain) {
      return LinkModes.AUTO;
    }

    const cleanDomain = domain.toLowerCase().trim();

    // 2. 精确匹配当前域名（如 "www.baidu.com"）
    if (linkRules[cleanDomain]) {
      return linkRules[cleanDomain];
    }

    // 3. 智能兼容：去掉 www. 前缀匹配（如 www.baidu.com -> baidu.com）
    if (cleanDomain.startsWith('www.')) {
      const rootDomain = cleanDomain.slice(4);
      if (linkRules[rootDomain]) {
        return linkRules[rootDomain];
      }
    }

    // 4. 智能兼容：加上 www. 前缀匹配（如 baidu.com -> www.baidu.com）
    const withWww = 'www.' + cleanDomain;
    if (linkRules[withWww]) {
      return linkRules[withWww];
    }

    // 5. 逐级向上递归父级主域名匹配（例如 a.b.c.qq.com -> b.c.qq.com -> c.qq.com -> qq.com）
    const parts = cleanDomain.split('.');
    while (parts.length > 2) {
      parts.shift();
      const parentDomain = parts.join('.');
      if (linkRules[parentDomain]) {
        return linkRules[parentDomain];
      }
    }

    // 6. 默认回退至自动模式
    return LinkModes.AUTO;
  }
}


// ===== [模块: src/content/form-detector.js] =====
/**
 * @file form-detector.js
 * @description 页面表单输入保护探测器（检测未保存修改或正在键入的输入控件）
 * @encoding UTF-8
 */

class FormDetector {
  /**
   * 探测当前页面是否存在活跃输入或未提交修改
   * @returns {{ hasActiveInput: boolean, reason?: string }}
   */
  static detectActiveForm() {
    try {
      // 1. 检测当前获得焦点的元素是否属于输入类控件
      const activeEl = document.activeElement;
      if (activeEl && activeEl !== document.body && activeEl !== document.documentElement) {
        const tagName = activeEl.tagName.toLowerCase();
        const isEditable = activeEl.isContentEditable;

        if (tagName === 'textarea') {
          return {
            hasActiveInput: true,
            reason: '文本域 (textarea) 正在输入中'
          };
        }

        if (tagName === 'input') {
          const type = (activeEl.getAttribute('type') || 'text').toLowerCase();
          // 忽略只读、按钮类、提交类 input
          const nonTypingTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'hidden', 'image'];
          if (!nonTypingTypes.includes(type)) {
            return {
              hasActiveInput: true,
              reason: `输入框 (input[type="${type}"]) 正在输入中`
            };
          }
        }

        if (isEditable) {
          return {
            hasActiveInput: true,
            reason: '富文本/可编辑区域正在编辑中'
          };
        }
      }

      // 2. 深度扫描页面中被用户修改过且非空的表单输入框 (Dirty State 检测)
      const textareas = document.querySelectorAll('textarea');
      for (const ta of textareas) {
        if (ta.value && ta.value.trim().length > 0 && ta.value !== ta.defaultValue) {
          return {
            hasActiveInput: true,
            reason: '页面内存在已输入但未提交的多行文本'
          };
        }
      }

      const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])');
      for (const inp of inputs) {
        if (inp.value && inp.value.trim().length > 0 && inp.value !== inp.defaultValue) {
          // 过滤掉默认搜索框等极简查询词，如字数大于 2 并且发生过修改
          if (inp.value.length > 2) {
            return {
              hasActiveInput: true,
              reason: '页面内存在已填写的表单内容'
            };
          }
        }
      }

      // 3. 常见富文本/代码编辑器活跃编辑状态检测（精准排除静态只读代码块）
      // ⚠️ 仅当编辑器（或其内部输入区）真正持有焦点时才判定为"正在编辑"：
      //    Slack/Gmail/Notion 等页面常驻大型 contenteditable 容器，
      //    若仅凭内容长度判定，此类页面将永远无法被自动收纳（系统性误报）
      const richEditors = document.querySelectorAll(
        '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], .monaco-editor, .CodeMirror, .ql-editor, .ProseMirror'
      );
      for (const editor of richEditors) {
        if (editor.getAttribute('aria-readonly') === 'true' || editor.classList.contains('read-only')) {
          continue;
        }
        // 仅当编辑器当前正在被编辑（自身或内部持有焦点）且有实质内容
        const isEditingHere =
          editor === document.activeElement ||
          editor.contains(document.activeElement) ||
          Boolean(editor.querySelector(':focus'));
        if (isEditingHere && editor.isContentEditable && editor.textContent && editor.textContent.trim().length > 0) {
          return {
            hasActiveInput: true,
            reason: '富文本正文处于可编辑状态'
          };
        }
        // 若为 Monaco / CodeMirror 等编辑器且内部输入框正在获取焦点输入
        const hasActiveTyping = editor.querySelector('textarea:focus, input:focus, textarea.inputarea:focus, .CodeMirror-focused');
        if (hasActiveTyping) {
          return {
            hasActiveInput: true,
            reason: '代码编辑器正在键入中'
          };
        }
      }

      return { hasActiveInput: false };
    } catch (err) {
      console.warn('[FormDetector] 检测表单异常:', err);
      return { hasActiveInput: false };
    }
  }
}



// ===== [模块: src/content/link-interceptor.js] =====
/**
 * @file link-interceptor.js
 * @description 智能链接跳转捕获与拦截器；自动模式不扫描 DOM、不监听悬浮、不启动 MutationObserver
 * @encoding UTF-8
 */





class LinkInterceptor {
  constructor() {
    this.currentDomain = window.location.hostname.toLowerCase();
    this.effectiveMode = LinkModes.AUTO;
    this.isInitialized = false;
    this.isLightweight = false;
    this.lastHandledUrl = '';
    this.lastHandledTime = 0;
    this.gestureOpenBudget = 0;
    this.patchedAnchors = new Set();
    this.domObserver = null;
    this._enhancedDom = false;
    this._syncTimer = null;
    this._waitingForBody = false;

    this._handlePointerDown = (event) => {
      if (event.isTrusted) this.gestureOpenBudget = 1;
    };
    this._handleKeyDown = (event) => {
      if (event.isTrusted && (event.key === 'Enter' || event.key === ' ')) this.gestureOpenBudget = 1;
    };
    this._clearGestureBudget = (event) => {
      if (!event.isTrusted) return;
      queueMicrotask(() => {
        this.gestureOpenBudget = 0;
      });
    };
    this._handleClick = (event) => this.handleLinkClick(event);
    this._handleHover = (event) => {
      const anchor = event.target?.closest?.('a[href]');
      if (anchor) this.patchAnchorTarget(anchor);
    };
    this._handleMainWorldOpen = (event) => this.handleMainWorldOpen(event);
    this._startObserverAfterDomReady = () => {
      this._waitingForBody = false;
      if (this.effectiveMode !== LinkModes.AUTO) this.startDOMObserver();
    };
    this._destroyOnPageHide = () => this.destroy();
  }

  async init(options = {}) {
    if (this.isInitialized) return;
    this.isLightweight = Boolean(options.lightweight);

    await this.refreshRulesCache();
    this.initGestureGate();
    window.addEventListener('__BETTER_BROWSE_OPEN_NEW_TAB__', this._handleMainWorldOpen);
    document.addEventListener('click', this._handleClick, true);
    window.addEventListener('pagehide', this._destroyOnPageHide, { once: true });
    this.isInitialized = true;

    this.syncModeToMainWorld();
    this.applyModeResources({ initial: true });
  }

  initGestureGate() {
    document.addEventListener('pointerdown', this._handlePointerDown, true);
    document.addEventListener('keydown', this._handleKeyDown, true);
    document.addEventListener('click', this._clearGestureBudget, true);
  }

  shouldAllowOpenEvent() {
    if (this.gestureOpenBudget < 1) return false;
    this.gestureOpenBudget = 0;
    return true;
  }

  safeSendMessage(message) {
    if (!chrome.runtime?.id) return;
    try {
      const chromeResult = chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
      if (chromeResult != null && typeof chromeResult.then === 'function') {
        chromeResult.then(() => {}, () => {});
      }
    } catch {
      // 扩展重载后静默释放失效上下文
    }
  }

  handleMainWorldOpen(event) {
    const url = event?.detail?.url;
    if (!this.isSafeHttpUrl(url) || this.effectiveMode !== LinkModes.NEW) return;
    if (this.lastHandledUrl === url && Date.now() - this.lastHandledTime < 500) return;
    if (!this.shouldAllowOpenEvent()) return;

    this.lastHandledUrl = url;
    this.lastHandledTime = Date.now();
    this.safeSendMessage({
      action: ActionTypes.OPEN_TAB_BACKGROUND,
      payload: { url, active: true }
    });
  }

  isSafeHttpUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !LinkMatcher.isInterceptionAllowed(rawUrl)) return false;
    try {
      const parsed = new URL(rawUrl, window.location.href);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  syncModeToMainWorld() {
    const mode = this.effectiveMode;
    try {
      document.documentElement?.setAttribute('data-better-browse-mode', mode);
    } catch {
      // 忽略页面阻止属性写入的异常
    }
    window.dispatchEvent(new CustomEvent('__BETTER_BROWSE_SYNC_MODE__', { detail: { mode } }));
  }

  async refreshRulesCache() {
    if (!chrome.runtime?.id) return;
    try {
      const response = await new Promise((resolve) => {
        const chromeResult = chrome.runtime.sendMessage({ action: ActionTypes.GET_PAGE_LINK_CONTEXT }, (result) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(result);
        });
        if (chromeResult != null && typeof chromeResult.then === 'function') {
          chromeResult.then(() => {}, () => {});
        }
      });
      const data = response?.data || response;
      this.applyEffectiveMode(data?.effectiveMode || data);
      if (this.normalizeMode(this.effectiveMode)) return;

      // 兼容主线尚未切换到最小响应的过渡期；接入后此分支可删除。
      if (data && typeof data === 'object') {
        this.effectiveMode = LinkMatcher.resolveEffectiveMode({
          domain: data.domain || this.currentDomain,
          linkRules: data.linkRules && typeof data.linkRules === 'object' ? data.linkRules : {},
          globalLinkRule: data.globalLinkRule || { enabled: false, mode: LinkModes.AUTO }
        });
      }
    } catch {
      // 后台未就绪时保持当前内存模式
    }
  }

  normalizeMode(mode) {
    return mode === LinkModes.AUTO || mode === LinkModes.CURRENT || mode === LinkModes.NEW ? mode : null;
  }

  applyEffectiveMode(mode) {
    const normalized = this.normalizeMode(mode);
    if (normalized) this.effectiveMode = normalized;
  }

  scheduleSync() {
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      this.syncModeToMainWorld();
      this.applyModeResources();
    }, 150);
  }

  getEffectiveMode() {
    return this.effectiveMode;
  }

  applyModeResources({ initial = false } = {}) {
    if (this.isLightweight) return;

    if (this.effectiveMode === LinkModes.AUTO) {
      this.stopEnhancedDomHandling();
      return;
    }

    const wasInactive = !this.domObserver;
    this.startEnhancedDomHandling();
    if (initial || wasInactive) {
      this.syncAllPageLinks();
    } else {
      for (const anchor of [...this.patchedAnchors]) {
        if (!anchor?.isConnected) this.patchedAnchors.delete(anchor);
        else this.patchAnchorTarget(anchor);
      }
    }
  }

  startEnhancedDomHandling() {
    if (!this._enhancedDom) {
      document.addEventListener('mouseover', this._handleHover, { passive: true, capture: true });
      this._enhancedDom = true;
    }
    this.startDOMObserver();
  }

  stopEnhancedDomHandling() {
    if (this._enhancedDom) {
      document.removeEventListener('mouseover', this._handleHover, true);
      this._enhancedDom = false;
    }
    this.domObserver?.disconnect();
    this.domObserver = null;
    if (this._waitingForBody) {
      document.removeEventListener('DOMContentLoaded', this._startObserverAfterDomReady);
      this._waitingForBody = false;
    }
    for (const anchor of [...this.patchedAnchors]) this.restoreAnchor(anchor);
    this.patchedAnchors.clear();
  }

  startDOMObserver() {
    if (this.domObserver || this.effectiveMode === LinkModes.AUTO) return;
    if (!document.body) {
      if (!this._waitingForBody) {
        this._waitingForBody = true;
        document.addEventListener('DOMContentLoaded', this._startObserverAfterDomReady, { once: true });
      }
      return;
    }

    try {
      this.domObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) this.patchAddedNode(node);
        }
      });
      this.domObserver.observe(document.body, { childList: true, subtree: true });
    } catch (err) {
      console.warn('[LinkInterceptor] DOM 观察器启动异常:', err);
    }
  }

  patchAddedNode(node) {
    if (this.effectiveMode === LinkModes.AUTO || node?.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches?.('a[href]')) this.patchAnchorTarget(node);
    for (const anchor of node.querySelectorAll?.('a[href]') || []) this.patchAnchorTarget(anchor);
  }

  syncAllPageLinks() {
    if (this.effectiveMode === LinkModes.AUTO || this.isLightweight) return;
    for (const anchor of document.querySelectorAll('a[href]')) this.patchAnchorTarget(anchor);
  }

  patchAnchorTarget(anchor) {
    if (!anchor || this.effectiveMode === LinkModes.AUTO) return;
    const href = anchor.getAttribute('href');
    if (!LinkMatcher.isInterceptionAllowed(href)) return;

    if (!anchor.hasAttribute('data-bb-orig-target')) {
      anchor.setAttribute('data-bb-orig-target', anchor.getAttribute('target') || '__NONE__');
    }
    this.patchedAnchors.add(anchor);

    if (this.effectiveMode === LinkModes.NEW) {
      anchor.setAttribute('target', '_blank');
      const rel = anchor.getAttribute('rel') || '';
      if (!anchor.hasAttribute('data-bb-orig-rel')) {
        anchor.setAttribute('data-bb-orig-rel', rel || '__NONE__');
      }
      const relTokens = new Set(rel.split(/\s+/).filter(Boolean));
      relTokens.add('noopener');
      relTokens.add('noreferrer');
      anchor.setAttribute('rel', [...relTokens].join(' '));
      return;
    }

    anchor.setAttribute('target', '_self');
    this.restoreOriginalRel(anchor);
  }

  restoreOriginalRel(anchor) {
    if (!anchor.hasAttribute('data-bb-orig-rel')) return;
    const original = anchor.getAttribute('data-bb-orig-rel');
    if (original === '__NONE__') anchor.removeAttribute('rel');
    else anchor.setAttribute('rel', original);
  }

  restoreAnchor(anchor) {
    if (!anchor) return;
    if (anchor.hasAttribute('data-bb-orig-target')) {
      const original = anchor.getAttribute('data-bb-orig-target');
      if (original === '__NONE__') anchor.removeAttribute('target');
      else anchor.setAttribute('target', original);
      anchor.removeAttribute('data-bb-orig-target');
    }
    this.restoreOriginalRel(anchor);
    anchor.removeAttribute('data-bb-orig-rel');
  }

  handleLinkClick(event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (this.effectiveMode === LinkModes.AUTO) return;

    const targetElement = event.target;
    if (!targetElement || typeof targetElement.closest !== 'function') return;

    const formControl = targetElement.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    );
    if (formControl) return;

    const buttonEl = targetElement.closest('button');
    let anchor = targetElement.closest('a[href]');
    if (buttonEl && (!anchor || buttonEl.contains(anchor))) return;
    if (!anchor) {
      const topicRow = targetElement.closest('.topic-list-item, .topic-item');
      anchor = topicRow?.querySelector('a.title, a.raw-topic-link, a.topic-link, a[href]') || null;
    }
    if (!anchor) return;

    const rawHref = anchor.getAttribute('href');
    const fullUrl = anchor.href;
    if (!LinkMatcher.isInterceptionAllowed(rawHref) || !fullUrl || !LinkMatcher.isInterceptionAllowed(fullUrl)) return;

    try {
      const currentUrlNoHash = window.location.href.split('#')[0];
      const targetUrlNoHash = fullUrl.split('#')[0];
      if (currentUrlNoHash === targetUrlNoHash && rawHref.startsWith('#')) return;
    } catch {
      // 忽略 URL 比较异常
    }

    if (this.effectiveMode === LinkModes.NEW) {
      if (this.lastHandledUrl === fullUrl && Date.now() - this.lastHandledTime < 500) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!this.shouldAllowOpenEvent()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      this.lastHandledUrl = fullUrl;
      this.lastHandledTime = Date.now();
      event.preventDefault();
      event.stopImmediatePropagation();
      this.safeSendMessage({
        action: ActionTypes.OPEN_TAB_BACKGROUND,
        payload: { url: fullUrl, active: true }
      });
      return;
    }

    if ((anchor.getAttribute('target') || '').toLowerCase() === '_blank') {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.location.href = fullUrl;
    }
  }

  destroy() {
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    this.stopEnhancedDomHandling();
    document.removeEventListener('pointerdown', this._handlePointerDown, true);
    document.removeEventListener('keydown', this._handleKeyDown, true);
    document.removeEventListener('click', this._clearGestureBudget, true);
    document.removeEventListener('click', this._handleClick, true);
    window.removeEventListener('__BETTER_BROWSE_OPEN_NEW_TAB__', this._handleMainWorldOpen);
    window.removeEventListener('pagehide', this._destroyOnPageHide);
    this.isInitialized = false;
  }
}


// ===== [模块: src/content/frame-index.js] =====
/**
 * @file frame-index.js
 * @description iframe 轻量内容脚本入口，仅保留点击拦截、模式同步与表单检测
 * @encoding UTF-8
 */





if (window.top !== window.self) {
  const linkInterceptor = new LinkInterceptor();
  linkInterceptor.init({ lightweight: true }).catch((err) => {
    console.warn('[BetterBrowse] iframe 轻量拦截器初始化失败:', err);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.action) return false;

    if (message.action === ActionTypes.CHECK_FORM_INPUT) {
      sendResponse({ success: true, data: FormDetector.detectActiveForm() });
      return false;
    }

    if (message.action === ActionTypes.NOTIFY_RULE_UPDATED || message.action === ActionTypes.NOTIFY_CONFIG_UPDATED) {
      const nextMode = message.payload?.effectiveMode;
      if (nextMode) {
        linkInterceptor.applyEffectiveMode(nextMode);
        linkInterceptor.scheduleSync();
      } else {
        linkInterceptor.refreshRulesCache().then(() => linkInterceptor.scheduleSync());
      }
      sendResponse({ success: true });
      return false;
    }

    return false;
  });
}


})();
