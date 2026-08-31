/**
 * @file content-bundle.js
 * @description Better Browse 内容脚本打包产物（自包含、无外部依赖、100% 站点兼容）
 * @encoding UTF-8
 */
(function() {
  'use strict';
  // 防重复执行守卫：后台广播倒计时卡片时会对未响应的标签页动态重注入本产物，
  // 二次执行会导致监听器叠加（如一次点击开两个标签），必须在最顶部拦截
  if (window.__BETTER_BROWSE_CONTENT_BUNDLE_LOADED__) {
    return;
  }
  window.__BETTER_BROWSE_CONTENT_BUNDLE_LOADED__ = true;

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
  CLEAR_AI_AUDIT_LOG: 'CLEAR_AI_AUDIT_LOG',    // 清空 AI 操作审计日志（选项页维护用）

  // === 30 天回收站 ===
  LIST_RECYCLE_BIN: 'LIST_RECYCLE_BIN',                 // 列出未过期墓碑（组/条目）
  RESTORE_RECYCLE_BIN_ITEM: 'RESTORE_RECYCLE_BIN_ITEM', // 从回收站恢复 { tombstoneId }
  PURGE_RECYCLE_BIN_ITEM: 'PURGE_RECYCLE_BIN_ITEM',     // 永久删除回收站项 { tombstoneId, confirm: true }

  // === 云端同步损坏恢复 ===
  GET_SYNC_RECOVERY_INFO: 'GET_SYNC_RECOVERY_INFO',         // 读取损坏状态与本机快照可用性
  FALLBACK_PREVIOUS_SNAPSHOT: 'FALLBACK_PREVIOUS_SNAPSHOT', // 回退上一份远端/本地快照
  REBUILD_SYNC_FROM_SCRATCH: 'REBUILD_SYNC_FROM_SCRATCH'    // 从本机快照重建同步 { confirm: true }
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
  }
};

// v5：收纳组数据迁移至 IndexedDB 本地主库（页面实体 + 收纳记录两层模型）
// v6：修复历史恢复操作产生的双前缀重复条目并清理孤儿条目（见 MigrationManager.repairIndexedEntries）
// v7：配置、链接规则、活动统计与自动备份迁入 IndexedDB（阶段一 M2 全量）
// v8：WebDAV 同步仓储、按 pageId 的活跃度、实体同步元数据（阶段二 M3）
const CURRENT_SCHEMA_VERSION = 8;


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



// ===== [模块: src/content/countdown-banner.js] =====
/**
 * @file countdown-banner.js
 * @description 网页端超阈值智能收纳倒计时悬浮卡片（采用 Shadow DOM 彻底隔离宿主样式）
 * @encoding UTF-8
 */



class CountdownBanner {
  static currentInstance = null;

  /**
   * 在当前页面展示倒计时卡片
   * @param {Object} options
   * @param {number} [options.countdownSeconds=15] - 倒计时秒数
   * @param {number} [options.currentCount=15] - 当前标签页总数
   * @param {number} [options.threshold=15] - 设定的阈值
   */
  static show({ countdownSeconds = 15, currentCount = 15, threshold = 15 } = {}) {
    // 若已有实例在展示，先平滑销毁
    if (this.currentInstance) {
      this.currentInstance.destroy();
    }

    const banner = new CountdownBanner({
      countdownSeconds,
      currentCount,
      threshold
    });
    banner.render();
    this.currentInstance = banner;
    return banner;
  }

  /**
   * 销毁并隐藏倒计时卡片
   */
  static hide() {
    if (this.currentInstance) {
      this.currentInstance.fadeOutAndRemove();
    }
  }

  constructor({ countdownSeconds, currentCount, threshold }) {
    this.totalSeconds = Math.max(3, countdownSeconds || 15);
    this.remainingSeconds = this.totalSeconds;
    this.currentCount = currentCount;
    this.threshold = threshold;
    this.timer = null;
    this.hostElement = null;
    this.shadowRoot = null;
    this.isProcessing = false;
  }

  /**
   * 渲染 Shadow DOM
   */
  render() {
    // 1. 创建容器 Host
    this.hostElement = document.createElement('better-browse-countdown-root');
    this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });

    // 2. 注入独立样式与 HTML
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
          display: block !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          position: fixed !important;
          top: 24px !important;
          right: 24px !important;
          z-index: 2147483647 !important;
          pointer-events: auto !important;
        }

        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        .banner-card {
          width: 330px;
          background: rgba(255, 255, 255, 0.96);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(0, 0, 0, 0.08);
          border-radius: 14px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12), 0 1px 4px rgba(0, 0, 0, 0.06);
          padding: 16px;
          color: #1f2937;
          font-size: 13px;
          line-height: 1.5;
          animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          transition: opacity 0.25s ease, transform 0.25s ease;
          overflow: hidden;
        }

        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(-16px) scale(0.96);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .banner-card.fade-out {
          opacity: 0;
          transform: translateY(-12px) scale(0.96);
        }

        /* 头部信息 */
        .card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 10px;
        }

        .header-title-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .card-icon {
          font-size: 16px;
          line-height: 1;
        }

        .card-title {
          font-size: 13px;
          font-weight: 600;
          color: #111827;
        }

        .threshold-tag {
          font-size: 11px;
          font-weight: 500;
          color: #d97706;
          background: #fef3c7;
          padding: 2px 6px;
          border-radius: 6px;
        }

        .btn-close {
          background: transparent;
          border: none;
          color: #9ca3af;
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
          padding: 4px;
          border-radius: 4px;
          transition: all 0.15s ease;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .btn-close:hover {
          color: #4b5563;
          background: rgba(0, 0, 0, 0.05);
        }

        /* 主体说明与倒计时数字 */
        .card-body {
          margin-bottom: 12px;
          color: #4b5563;
        }

        .highlight-text {
          font-weight: 600;
          color: #111827;
        }

        .countdown-indicator {
          display: inline-flex;
          align-items: center;
          font-weight: 700;
          color: #2563eb;
          background: #eff6ff;
          padding: 1px 6px;
          border-radius: 4px;
          margin: 0 2px;
        }

        /* 进度条 */
        .progress-track {
          width: 100%;
          height: 3px;
          background: #e5e7eb;
          border-radius: 2px;
          overflow: hidden;
          margin-bottom: 14px;
        }

        .progress-bar {
          height: 100%;
          width: 100%;
          background: linear-gradient(90deg, #3b82f6, #6366f1);
          border-radius: 2px;
          transition: width 1s linear;
        }

        /* 按钮操作组 */
        .card-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 6px 12px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          border: 1px solid transparent;
          transition: all 0.15s ease;
          line-height: 1.2;
          user-select: none;
        }

        .btn-secondary {
          background: #f3f4f6;
          color: #4b5563;
          border-color: #e5e7eb;
        }

        .btn-secondary:hover {
          background: #e5e7eb;
          color: #1f2937;
        }

        .btn-primary {
          background: #2563eb;
          color: #ffffff;
        }

        .btn-primary:hover {
          background: #1d4ed8;
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        /* 深色模式自适应 */
        @media (prefers-color-scheme: dark) {
          .banner-card {
            background: rgba(30, 41, 59, 0.94);
            border-color: rgba(255, 255, 255, 0.1);
            color: #e2e8f0;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
          }
          .card-title {
            color: #f8fafc;
          }
          .card-body {
            color: #cbd5e1;
          }
          .highlight-text {
            color: #ffffff;
          }
          .threshold-tag {
            background: rgba(217, 119, 6, 0.2);
            color: #fbbf24;
          }
          .btn-close {
            color: #94a3b8;
          }
          .btn-close:hover {
            color: #f1f5f9;
            background: rgba(255, 255, 255, 0.08);
          }
          .countdown-indicator {
            background: rgba(37, 99, 235, 0.25);
            color: #93c5fd;
          }
          .progress-track {
            background: #334155;
          }
          .btn-secondary {
            background: #334155;
            color: #e2e8f0;
            border-color: #475569;
          }
          .btn-secondary:hover {
            background: #475569;
            color: #ffffff;
          }
        }
      </style>

      <div class="banner-card" id="bannerCard">
        <div class="card-header">
          <div class="header-title-wrap">
            <span class="card-icon">📦</span>
            <span class="card-title">BetterBrowse</span>
            <span class="threshold-tag">标签已满 ${this.currentCount}</span>
          </div>
          <button class="btn-close" id="btnClose" title="关闭并取消本次收纳" aria-label="关闭">✕</button>
        </div>

        <div class="card-body" id="cardBody">
          当前标签数已达 <span class="highlight-text">${this.currentCount}</span> 个（阈值 ${this.threshold}），将在 <span class="countdown-indicator" id="countdownNum">${this.remainingSeconds}s</span> 后自动智能收纳闲置标签...
        </div>

        <div class="progress-track">
          <div class="progress-bar" id="progressBar"></div>
        </div>

        <div class="card-actions" id="cardActions">
          <button class="btn btn-secondary" id="btnCancel">取消收纳</button>
          <button class="btn btn-primary" id="btnStashNow">立即收纳</button>
        </div>
      </div>
    `;

    // 确保 Host 节点内联样式最高优先级
    this.hostElement.style.cssText = 'all: initial !important; display: block !important; position: fixed !important; top: 24px !important; right: 24px !important; z-index: 2147483647 !important; pointer-events: auto !important;';

    const targetContainer = document.body || document.documentElement;
    if (targetContainer) {
      targetContainer.appendChild(this.hostElement);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        (document.body || document.documentElement)?.appendChild(this.hostElement);
      });
    }

    // 3. 绑定交互事件
    this.bindEvents();

    // 4. 启动 1 秒心跳定时器
    this.startCountdown();
  }

  bindEvents() {
    const btnClose = this.shadowRoot.getElementById('btnClose');
    const btnCancel = this.shadowRoot.getElementById('btnCancel');
    const btnStashNow = this.shadowRoot.getElementById('btnStashNow');

    const handleCancel = () => {
      if (this.isProcessing) return;
      this.cancelAutoStash();
    };

    btnClose.addEventListener('click', handleCancel);
    btnCancel.addEventListener('click', handleCancel);

    btnStashNow.addEventListener('click', () => {
      if (this.isProcessing) return;
      this.confirmAutoStash();
    });
  }

  /**
   * 启动每秒递减定时器
   */
  startCountdown() {
    const countdownNum = this.shadowRoot.getElementById('countdownNum');
    const progressBar = this.shadowRoot.getElementById('progressBar');

    this.timer = setInterval(() => {
      this.remainingSeconds -= 1;

      if (countdownNum) {
        countdownNum.textContent = `${this.remainingSeconds}s`;
      }

      if (progressBar) {
        const percent = Math.max(0, (this.remainingSeconds / this.totalSeconds) * 100);
        progressBar.style.width = `${percent}%`;
      }

      // 倒计时仅负责展示，自动收纳由后台唯一计时器触发，避免重复执行
      if (this.remainingSeconds <= 0) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 1000);
  }

  /**
   * 取消自动收纳（通知后台并进入冷却）
   */
  cancelAutoStash() {
    this.stopTimer();
    try {
      const chromeResult = chrome.runtime.sendMessage({ action: ActionTypes.CANCEL_AUTO_STASH }, () => {
        // 显式消费 lastError，避免扩展重载后产生未处理的错误噪音
        void chrome.runtime.lastError;
      });
      if (chromeResult != null && typeof chromeResult.then === 'function') {
        chromeResult.then(() => {}, () => {});
      }
    } catch {
      // 忽略通信断开
    }
    this.fadeOutAndRemove();
  }

  /**
   * 确认执行自动智能收纳
   */
  async confirmAutoStash() {
    this.stopTimer();
    this.isProcessing = true;

    const cardBody = this.shadowRoot.getElementById('cardBody');
    const cardActions = this.shadowRoot.getElementById('cardActions');
    const progressBar = this.shadowRoot.getElementById('progressBar');

    if (cardBody) {
      cardBody.innerHTML = '⏳ 正在评估规则并智能收纳闲置标签...';
    }
    if (cardActions) {
      cardActions.style.display = 'none';
    }
    if (progressBar) {
      progressBar.style.width = '100%';
    }

    try {
      const response = await new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          // 后台无响应（扩展重载/SW 休眠）时的超时兜底，避免卡片永久停留在"正在评估"
          resolve(null);
        }, 10000);
        try {
          const chromeResult = chrome.runtime.sendMessage({ action: ActionTypes.CONFIRM_AUTO_STASH }, (res) => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(res);
          });
          if (chromeResult != null && typeof chromeResult.then === 'function') {
            chromeResult.then(() => {}, () => {});
          }
        } catch {
          clearTimeout(timeoutId);
          resolve(null);
        }
      });

      if (response && response.success && response.data) {
        const { stashedCount, keptCount } = response.data;
        if (cardBody) {
          if (stashedCount > 0) {
            cardBody.innerHTML = `✅ 已智能收纳 <strong>${stashedCount}</strong> 个闲置标签（保留 <strong>${keptCount || 0}</strong> 个活跃标签）`;
          } else {
            cardBody.innerHTML = 'ℹ️ 当前所有标签均处于活跃/保护状态，未收纳标签';
          }
        }
      } else if (response && !response.success) {
        if (cardBody) {
          cardBody.innerHTML = 'ℹ️ 当前无可收纳的标签页';
        }
      } else {
        if (cardBody) {
          cardBody.innerHTML = '收纳指令已发送';
        }
      }
    } catch (err) {
      if (cardBody) {
        cardBody.innerHTML = '收纳指令已发送';
      }
    }

    // 展示结果 1.5 秒后平滑淡出
    setTimeout(() => {
      this.fadeOutAndRemove();
    }, 1500);
  }

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 平滑淡出并移除 DOM
   */
  fadeOutAndRemove() {
    const card = this.shadowRoot?.getElementById('bannerCard');
    if (card) {
      card.classList.add('fade-out');
      setTimeout(() => {
        this.destroy();
      }, 250);
    } else {
      this.destroy();
    }
  }

  destroy() {
    this.stopTimer();
    if (this.hostElement && this.hostElement.parentNode) {
      this.hostElement.parentNode.removeChild(this.hostElement);
    }
    this.hostElement = null;
    this.shadowRoot = null;
    if (CountdownBanner.currentInstance === this) {
      CountdownBanner.currentInstance = null;
    }
  }
}


// ===== [模块: src/content/link-interceptor.js] =====
/**
 * @file link-interceptor.js
 * @description 智能链接跳转捕获与拦截器（主世界注入桥接 + 隔离世界双层拦截，100% 免疫 SPA/Ember/Vue/React 路由劫持）
 * @encoding UTF-8
 */





class LinkInterceptor {
  /** 开标签事件速率限制：滑动窗口内最多允许的次数与窗口时长 */
  static OPEN_EVENT_LIMIT = 10;
  static OPEN_EVENT_WINDOW_MS = 10000;

  constructor() {
    this.currentDomain = window.location.hostname.toLowerCase();
    this.linkRules = {};
    this.globalLinkRule = { enabled: false, mode: LinkModes.AUTO };
    this.isInitialized = false;
    this.lastHandledUrl = '';
    this.lastHandledTime = 0;
    this.openEventTimestamps = [];
  }

  /**
   * 滑动窗口速率限制：__BETTER_BROWSE_OPEN_NEW_TAB__ 是页面脚本可伪造的公开事件，
   * 协议校验之外还需限制频次，防止被恶意页面当作绕过弹窗拦截的广告/钓鱼发射器
   * @returns {boolean} 是否允许本次开标签
   */
  shouldAllowOpenEvent() {
    const now = Date.now();
    this.openEventTimestamps = this.openEventTimestamps.filter(
      (ts) => now - ts < LinkInterceptor.OPEN_EVENT_WINDOW_MS
    );
    if (this.openEventTimestamps.length >= LinkInterceptor.OPEN_EVENT_LIMIT) {
      return false;
    }
    this.openEventTimestamps.push(now);
    return true;
  }

  /**
   * 安全发送消息至后台（防御扩展重载导致的上下文失效报错）
   * @param {Object} message
   */
  safeSendMessage(message) {
    if (!chrome.runtime?.id) return;
    try {
      const chromeResult = chrome.runtime.sendMessage(message, () => {
        // 静默处理扩展重载上下文失效
        void chrome.runtime.lastError;
      });
      // MV3：传入 callback 时仍可能返回会拒绝的 Promise
      if (chromeResult != null && typeof chromeResult.then === 'function') {
        chromeResult.then(() => {}, () => {});
      }
    } catch {
      // 静默处理异常
    }
  }

  /**
   * 初始化拦截器，预加载规则并建立本地缓存与事件监听
   * @param {{ lightweight?: boolean }} [options] - lightweight=true 时（iframe 内）跳过
   *   DOM 全量扫描与悬浮预处理，仅保留点击拦截与主世界事件桥接
   */
  async init(options = {}) {
    if (this.isInitialized) return;

    await this.refreshRulesCache();
    if (!options.lightweight) {
      this.initHoverListener();
      this.initDOMObserver();
    }
    this.initMainWorldEvents();
    this.initClickListener();
    this.syncModeToMainWorld();
    this.isInitialized = true;
  }

  /**
   * 监听来自主页面世界（Main World）的通信事件
   */
  initMainWorldEvents() {
    window.addEventListener('__BETTER_BROWSE_OPEN_NEW_TAB__', (event) => {
      const url = event?.detail?.url;
      if (!this.isSafeHttpUrl(url)) return;

      // 用户激活校验：合法路径（主世界点击拦截 / window.open 劫持）均在真实用户手势的
      // 同步调用栈内派发事件，navigator.userActivation 为激活态；
      // 页面脚本凭空伪造事件不产生用户激活，直接忽略（旧浏览器无此 API 时放行）
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        return;
      }

      // 频次限制兜底：即便页面持有真实用户激活，也不允许高频批量开标签
      if (!this.shouldAllowOpenEvent()) {
        return;
      }

      // 记录已由主世界拦截并处理的时间戳与 URL，彻底杜绝隔离世界二次重复发送消息
      this.lastHandledUrl = url;
      this.lastHandledTime = Date.now();

      this.safeSendMessage({
        action: ActionTypes.OPEN_TAB_BACKGROUND,
        payload: {
          url: url,
          active: true
        }
      });
    });
  }

  /**
   * 主世界事件属于公开页面 API，必须再次校验协议，防止页面脚本伪造特权 URL。
   * @param {unknown} rawUrl
   * @returns {boolean}
   */
  isSafeHttpUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !LinkMatcher.isInterceptionAllowed(rawUrl)) return false;
    try {
      const parsed = new URL(rawUrl, window.location.href);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * 将当前生效模式同步至主世界桥接器（CustomEvent + DOM dataset 双重通道）
   */
  syncModeToMainWorld() {
    const mode = this.getEffectiveMode();
    try {
      document.documentElement?.setAttribute('data-better-browse-mode', mode);
    } catch {
      // 忽略 DOM 操作异常
    }

    window.dispatchEvent(
      new CustomEvent('__BETTER_BROWSE_SYNC_MODE__', {
        detail: { mode }
      })
    );
  }

  /**
   * 向后台请求当前页最小必要跳转上下文（内容脚本不得直读 chrome.storage / IndexedDB）
   */
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
      if (data && typeof data === 'object') {
        this.linkRules = data.linkRules && typeof data.linkRules === 'object' ? data.linkRules : {};
        this.globalLinkRule = data.globalLinkRule || DefaultConfig.globalLinkRule || {
          enabled: false,
          mode: LinkModes.AUTO
        };
      }
    } catch {
      // 后台未就绪时保持现有内存缓存
    }
  }

  /**
   * 合并同步任务：后台 NOTIFY_RULE_UPDATED / NOTIFY_CONFIG_UPDATED 可能短时间内连发，
   * 防抖后只刷新一次主世界模式与页面链接
   */
  scheduleSync() {
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      this.syncModeToMainWorld();
      this.syncAllPageLinks();
    }, 150);
  }

  /**
   * 获取当前页面最终生效的跳转模式
   * @returns {'auto' | 'current' | 'new'}
   */
  getEffectiveMode() {
    return LinkMatcher.resolveEffectiveMode({
      domain: this.currentDomain,
      linkRules: this.linkRules,
      globalLinkRule: this.globalLinkRule
    });
  }

  /**
   * 绑定捕获阶段（Capture Phase）点击事件监听
   */
  initClickListener() {
    document.addEventListener(
      'click',
      (event) => {
        this.handleLinkClick(event);
      },
      true // 捕获阶段拦截
    );
  }

  /**
   * 绑定鼠标悬浮预处理，提前修正 target 属性
   */
  initHoverListener() {
    document.addEventListener(
      'mouseover',
      (event) => {
        const anchor = event.target?.closest?.('a[href]');
        if (anchor) {
          this.patchAnchorTarget(anchor);
        }
      },
      { passive: true, capture: true }
    );
  }

  /**
   * 监听 DOM 动态插入的超链接节点
   */
  initDOMObserver() {
    try {
      const observer = new MutationObserver(() => {
        if (this._observerTimer) return;
        this._observerTimer = setTimeout(() => {
          this.syncAllPageLinks();
          this._observerTimer = null;
        }, 500);
      });

      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
          }
        });
      }
    } catch (err) {
      console.warn('[LinkInterceptor] DOM 观察器启动异常:', err);
    }
  }

  /**
   * 批量同步页面中所有超链接属性（支持无损动态还原）
   */
  syncAllPageLinks() {
    const links = document.querySelectorAll('a[href]');
    for (const a of links) {
      this.patchAnchorTarget(a);
    }
  }

  /**
   * 修正单个超链接的 DOM 属性（支持可逆还原原始 target）
   * @param {HTMLAnchorElement} anchor
   */
  patchAnchorTarget(anchor) {
    const href = anchor.getAttribute('href');
    if (!LinkMatcher.isInterceptionAllowed(href)) return;

    const mode = this.getEffectiveMode();
    if (mode === LinkModes.NEW) {
      if (!anchor.hasAttribute('data-bb-orig-target')) {
        anchor.setAttribute('data-bb-orig-target', anchor.getAttribute('target') || '__NONE__');
      }
      anchor.setAttribute('target', '_blank');
      const rel = anchor.getAttribute('rel') || '';
      if (!rel.includes('noopener')) {
        if (!anchor.hasAttribute('data-bb-orig-rel')) {
          anchor.setAttribute('data-bb-orig-rel', rel || '__NONE__');
        }
        anchor.setAttribute('rel', (rel ? rel + ' ' : '') + 'noopener noreferrer');
      }
    } else if (mode === LinkModes.CURRENT) {
      if (!anchor.hasAttribute('data-bb-orig-target')) {
        anchor.setAttribute('data-bb-orig-target', anchor.getAttribute('target') || '__NONE__');
      }
      anchor.setAttribute('target', '_self');
    } else if (mode === LinkModes.AUTO) {
      if (anchor.hasAttribute('data-bb-orig-target')) {
        const orig = anchor.getAttribute('data-bb-orig-target');
        if (orig === '__NONE__') {
          anchor.removeAttribute('target');
        } else {
          anchor.setAttribute('target', orig);
        }
        anchor.removeAttribute('data-bb-orig-target');
      }
      // 同步还原曾被追加的 rel 字段，避免 rel 残留改变站点原生行为
      if (anchor.hasAttribute('data-bb-orig-rel')) {
        const origRel = anchor.getAttribute('data-bb-orig-rel');
        if (origRel === '__NONE__') {
          anchor.removeAttribute('rel');
        } else {
          anchor.setAttribute('rel', origRel);
        }
        anchor.removeAttribute('data-bb-orig-rel');
      }
    }
  }

  /**
   * 处理超链接点击核心拦截逻辑（隔离世界备用）
   * @param {MouseEvent} event
   */
  handleLinkClick(event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const targetElement = event.target;
    if (!targetElement || typeof targetElement.closest !== 'function') return;

    // 1. 过滤原生表单控件与原生 button（除非包含在 a[href] 中）
    const formControl = targetElement.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    );
    if (formControl) return;

    const buttonEl = targetElement.closest('button');
    let anchor = targetElement.closest('a[href]');
    if (buttonEl && (!anchor || buttonEl.contains(anchor))) {
      return;
    }

    if (!anchor) {
      const topicRow = targetElement.closest('.topic-list-item, .topic-item');
      if (topicRow) {
        anchor = topicRow.querySelector('a.title, a.raw-topic-link, a.topic-link, a[href]');
      }
    }

    if (!anchor) return;

    const rawHref = anchor.getAttribute('href');
    if (!LinkMatcher.isInterceptionAllowed(rawHref)) {
      return;
    }

    const fullUrl = anchor.href;
    if (!fullUrl || !LinkMatcher.isInterceptionAllowed(fullUrl)) {
      return;
    }

    try {
      const currentUrlNoHash = window.location.href.split('#')[0];
      const targetUrlNoHash = fullUrl.split('#')[0];
      if (currentUrlNoHash === targetUrlNoHash && rawHref.startsWith('#')) {
        return;
      }
    } catch {
      // 忽略比较异常
    }

    const effectiveMode = this.getEffectiveMode();

    if (effectiveMode === LinkModes.AUTO) {
      return;
    }

    if (effectiveMode === LinkModes.NEW) {
      // 若 500ms 内主世界或当前拦截器已处理过相同 URL 的打开操作，则阻止默认行为后忽略，
      // 杜绝重复开标签（该锚点已被 patch 为 target="_blank"，直接放行会触发浏览器原生开标签）
      if (this.lastHandledUrl === fullUrl && (Date.now() - this.lastHandledTime < 500)) {
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
        payload: {
          url: fullUrl,
          active: true
        }
      });
      return;
    }

    if (effectiveMode === LinkModes.CURRENT) {
      const currentTarget = (anchor.getAttribute('target') || '').toLowerCase();
      if (currentTarget === '_blank') {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.location.href = fullUrl;
        return;
      }
    }
  }
}


// ===== [模块: src/content/index.js] =====
/**
 * @file index.js
 * @description 内容脚本总入口（初始化链接拦截器与表单状态监听）
 * @encoding UTF-8
 */






// 是否处于 iframe 中：iframe 内启用轻量模式（仅点击拦截与主世界桥接），
// 跳过 DOM 全量扫描 / 悬浮预处理 / 倒计时卡片，避免广告等海量 iframe 拖累页面性能
const IS_IN_IFRAME = window.top !== window.self;

// 初始化并启动链接拦截器
const linkInterceptor = new LinkInterceptor();
linkInterceptor.init({ lightweight: IS_IN_IFRAME }).catch((err) => {
  console.warn('[BetterBrowse] 内容脚本链接拦截器初始化失败:', err);
});

// 监听来自后台/扩展的指令（例如表单状态检查与倒计时弹窗）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  // 表单检测在 iframe 内同样有意义（用户可能在 iframe 表单中输入）
  if (message.action === ActionTypes.CHECK_FORM_INPUT) {
    const result = FormDetector.detectActiveForm();
    sendResponse({
      success: true,
      data: result
    });
    return false;
  }

  // 倒计时卡片仅在顶层框架展示
  if (!IS_IN_IFRAME && message.action === ActionTypes.SHOW_AUTO_STASH_COUNTDOWN) {
    const { countdownSeconds, currentCount, threshold } = message.payload || {};
    CountdownBanner.show({ countdownSeconds, currentCount, threshold });
    sendResponse({ success: true });
    return false;
  }

  if (!IS_IN_IFRAME && message.action === ActionTypes.HIDE_AUTO_STASH_COUNTDOWN) {
    CountdownBanner.hide();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === ActionTypes.NOTIFY_RULE_UPDATED || message.action === ActionTypes.NOTIFY_CONFIG_UPDATED) {
    linkInterceptor.refreshRulesCache().then(() => {
      linkInterceptor.scheduleSync();
    });
    sendResponse({ success: true });
    return false;
  }

  return false;
});



})();
