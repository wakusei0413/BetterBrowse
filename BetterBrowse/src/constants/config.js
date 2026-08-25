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
  P3: 3, // 低优先级（固定标签页）
  DEFAULT: 99 // 默认收纳
};

export const DefaultConfig = {
  // === 标签页收纳阈值与触发配置 ===
  tabThreshold: 15,              // 触发自动收纳提示的标签页数量阈值
  autoThresholdNotify: true,     // 达到阈值时是否弹出通知提醒
  autoStashOnThreshold: true,    // 达到阈值时是否自动倒计时智能收纳
  countdownSeconds: 15,          // 自动收纳倒计时时长（秒，默认15秒）
  thresholdCooldownMinutes: 5,   // 取消或触发后的防打扰冷却时间（分钟，默认5分钟）
  recentActiveMinutes: 5,        // “最近访问”时间窗口（分钟，默认5分钟）
  frequencyPercentile: 0.2,      // “高频使用”保留比例（前20%）
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

  // === 🎯 收纳箱精细化设置（14 项设置） ===
  stashSettings: {
    // 1. 恢复行为策略：'remove' (恢复后删除) | 'keep' (恢复后保留) | 'archive' (恢复后标记归档)
    restoreBehavior: 'remove',
    // 2. 恢复打开位置：'currentWindow' (当前窗口) | 'newWindow' (新建独立窗口)
    restorePosition: 'currentWindow',
    // 3. 是否允许重复收纳相同的 URL
    allowDuplicates: true,
    // 4. 重复收纳时标题策略：'useOriginal' (保留初次收纳标题) | 'useLatest' (更新为最新标题)
    existingTabTitleBehavior: 'useOriginal',
    // 5. 点击收纳按钮后是否自动切换激活收纳箱标签
    autoOpenStashTab: true,
    // 6. 是否在首位死死常驻固定收纳小标签（Pinned Tab Guard）
    pinnedTabGuard: true,
    // 7. 删除收纳组/标签前是否弹出二次确认框
    deleteConfirmation: true,
    // 8. 扩展图标 Badge 上是否实时显示收纳标签总数
    showTabCountBadge: true,
    // 9. 智能收纳时是否跳过固定标签页
    excludePinnedTabs: true,
    // 10. 智能收纳时是否跳过正在播放媒体的标签页
    excludeAudibleTabs: true,
    // 11. 智能收纳时是否跳过表单编辑中页面
    excludeFormDirtyTabs: true,
    // 12. 是否开启每日自动定时备份导出
    autoBackupEnabled: true,
    // 13. 自动备份保留天数 (默认 30 天)
    backupRetentionDays: 30,
    // 14. 页面显示风格：'comfortable' (舒适模式) | 'compact' (紧凑模式)
    displayDensity: 'comfortable'
  }
};

export const CURRENT_SCHEMA_VERSION = 3;
