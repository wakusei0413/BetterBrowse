/**
 * @file config.js
 * @description 默认配置与业务常量定义
 * @encoding UTF-8
 */

export const LinkModes = {
  AUTO: 'auto',       // 🔄 自动模式（遵循网站原本行为）
  CURRENT: 'current', // ⬅️ 当前标签页打开
  NEW: 'new'          // ➡️ 新标签页打开
};

export const RulePriorities = {
  P0: 0, // 最高优先级（媒体播放、表单输入中）
  P1: 1, // 高优先级（最近访问）
  P2: 2, // 中优先级（高使用频率）
  P3: 3  // 低优先级（固定标签页）
};

export const DefaultConfig = {
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
export const LOCAL_DATA_SCHEMA_REVISION = 10;
