/**
 * @file constants.js
 * @description 选项页共享导航常量
 * @encoding UTF-8
 */

export const SETTINGS_SUBTAB_TITLES = {
  'stash-settings': '收纳箱设置',
  'rules': '智能收纳规则',
  'links': '域名跳转规则',
  'backup': '数据备份与迁移',
  'sync': '云端同步',
  'ai-bridge': 'AI 桥接',
  'logs': '运行日志',
  'about': '关于'
};
export const SETTINGS_SUBTABS = Object.keys(SETTINGS_SUBTAB_TITLES);

export const SETTINGS_TERTIARY_ROUTES = {
  'rules-tiered': {
    parent: 'rules',
    title: '阶梯降级策略'
  },
  'backup-onetab': {
    parent: 'backup',
    title: 'OneTab 迁移助手'
  },
  'backup-maintenance': {
    parent: 'backup',
    title: '数据维护'
  },
  'sync-conflicts': {
    parent: 'sync',
    title: '冲突裁决'
  },
  'sync-maintenance': {
    parent: 'sync',
    title: '设备与恢复'
  }
};
