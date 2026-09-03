/**
 * @file options.js
 * @description 选项与收纳管理中心视图控制器
 * @encoding UTF-8
 */

import { AIBridgeComponent } from './components/ai-bridge.js';
import { AboutComponent } from './components/about.js';
import { BackupComponent } from './components/backup.js';
import { CustomSelectEnhancer } from './ui/custom-select.js';
import { DomainRulesComponent } from './components/domain-rules.js';
import { RulesConfigComponent } from './components/rules-config.js';
import { RuntimeLogComponent } from './components/runtime-log.js';
import { SearchHomeComponent } from './components/search-home.js';
import { StashSettingsComponent } from './components/stash-settings.js';
import { StashTabComponent } from './components/stash-tab.js';
import { Toast } from './components/toast.js';
import { WebdavSyncComponent } from './components/webdav-sync.js';
import { SETTINGS_SUBTAB_TITLES, SETTINGS_SUBTABS } from './constants.js';
import { ActionTypes } from '../constants/action-types.js';
import { MessageBus } from '../core/bus/message-bus.js';
import { installRuntimeLogger } from '../core/logging/runtime-logger.js';

installRuntimeLogger({
  context: 'options',
  write: (entry) => MessageBus.sendToBackground(ActionTypes.APPEND_RUNTIME_LOG, entry)
});

export class OptionsApp {
  constructor() {
    this.tabStash = document.getElementById('tab-stash');
    this.tabSearch = document.getElementById('tab-search');
    this.viewSettingsHub = document.getElementById('view-settings-hub');
    this.btnSidebarSettings = document.getElementById('btnSidebarSettings');
    this.btnBackToStash = document.getElementById('btnBackToStash');
    this.navItemStash = document.getElementById('navTabStash');
    this.navItemSearch = document.getElementById('navTabSearch');
    this.subnavItems = document.querySelectorAll('.settings-subnav-item');
    this.breadcrumbCurrent = document.getElementById('settingsCurrentSubtabBreadcrumb');
    this.panels = document.querySelectorAll('.tab-panel');

    this.currentSettingsSubtab = 'stash-settings';

    this.init();
  }

  init() {
    this.components = new Map();
    this.componentFactories = {
      'stash-settings': () => new StashSettingsComponent(),
      rules: () => new RulesConfigComponent(),
      links: () => new DomainRulesComponent(),
      sync: () => new WebdavSyncComponent(),
      'ai-bridge': () => new AIBridgeComponent(),
      logs: () => new RuntimeLogComponent(),
      about: () => new AboutComponent(),
      backup: () => new BackupComponent(() => {
        this.components.get('stash')?.loadData?.();
        this.components.get('stash-settings')?.loadSettings?.();
        this.components.get('rules')?.loadConfig?.();
        this.components.get('links')?.loadRules?.();
      })
    };
    this.components.set('stash', new StashTabComponent());
    this.components.set('search', new SearchHomeComponent());
    this.bindNavigation();

    // 接收来自后台的主动通知；尚未打开的面板不提前实例化，首次进入时读取最新状态。
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.action) return false;
      if (message.action === 'SWITCH_OPTIONS_TAB' && message.payload?.tab) {
        this.switchTab(message.payload.tab);
      } else if (message.action === ActionTypes.OPEN_OPTIONS_PAGE && message.payload?.tab) {
        this.switchTab(message.payload.tab);
      } else if (message.action === ActionTypes.NOTIFY_STASH_UPDATED) {
        this.components.get('stash')?.loadData?.();
      } else if (message.action === ActionTypes.NOTIFY_RULE_UPDATED) {
        this.components.get('links')?.loadRules?.();
      } else if (message.action === ActionTypes.NOTIFY_CONFIG_UPDATED) {
        this.components.get('stash-settings')?.loadSettings?.();
        this.components.get('rules')?.loadConfig?.();
        this.components.get('sync')?.loadAccountConfigSync?.();
        this.components.get('ai-bridge')?.loadConfig?.();
      } else if (message.action === ActionTypes.NOTIFY_SYNC_UPDATED) {
        this.components.get('sync')?.loadAll?.();
      }
      return false;
    });

    window.addEventListener('hashchange', () => {
      const rawHash = window.location.hash.replace(/^#/, '');
      if (rawHash) this.switchTab(rawHash, false);
    });

    const rawHash = window.location.hash.replace(/^#/, '');
    this.switchTab(rawHash || 'stash', false);
  }

  ensureComponent(tabName) {
    if (!tabName || tabName === 'stash') return this.components.get('stash');
    if (this.components.has(tabName)) return this.components.get(tabName);
    const factory = this.componentFactories[tabName];
    if (!factory) return null;
    const component = factory();
    this.components.set(tabName, component);
    if (tabName === 'logs') this.runtimeLogComponent = component;
    CustomSelectEnhancer.enhanceAll(document.getElementById(`tab-${tabName}`) || document);
    return component;
  }

  bindNavigation() {
    // 侧边栏时间线按钮点击
    this.navItemStash?.addEventListener('click', () => {
      this.switchTab('stash');
    });

    // 侧边栏搜索主页按钮点击
    this.navItemSearch?.addEventListener('click', () => {
      this.switchTab('search');
    });

    // 侧边栏左下角系统设置按钮点击（进入统一设置中心）
    this.btnSidebarSettings?.addEventListener('click', () => {
      this.switchTab(this.currentSettingsSubtab || 'stash-settings');
    });

    // 设置中心顶部「返回时间线」按钮点击
    this.btnBackToStash?.addEventListener('click', () => {
      this.switchTab('stash');
    });

    // 设置中心二级子分类导航 Tab 点击
    this.subnavItems.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetSubtab = btn.getAttribute('data-subtab');
        if (targetSubtab) {
          this.switchTab(targetSubtab);
        }
      });
    });

    // 键盘 Esc 快捷键：当处于设置页面时快速退回时间线
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.viewSettingsHub && !this.viewSettingsHub.hidden) {
        const isEditingInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
        if (!isEditingInput) {
          this.switchTab('stash');
        }
      }
    });
  }

  /**
   * 统一切换视图与设置选项
   * @param {string} tabName 目标标签名 ('stash' | 'search' | 'settings' | 'stash-settings' | 'rules' | 'links' | 'backup' | 'sync' | 'ai-bridge' | 'logs')
   * @param {boolean} [updateHash=true] 是否同步更新 URL Hash
   */
  switchTab(tabName, updateHash = true) {
    if (!tabName) tabName = 'stash';

    const isStashView = tabName === 'stash';
    const isSearchView = tabName === 'search';
    const isSettingsSubtab = SETTINGS_SUBTABS.includes(tabName);
    const targetSubtab = isSettingsSubtab ? tabName : (tabName === 'settings' ? this.currentSettingsSubtab : null);

    if (isStashView) {
      // 1. 激活时间线主视图
      if (this.tabStash) {
        this.tabStash.classList.add('active');
        this.tabStash.hidden = false;
      }
      if (this.tabSearch) {
        this.tabSearch.classList.remove('active');
        this.tabSearch.hidden = true;
      }
      if (this.viewSettingsHub) {
        this.viewSettingsHub.classList.remove('active');
        this.viewSettingsHub.hidden = true;
      }

      // 2. 侧边栏按钮状态同步
      this.navItemStash?.classList.add('active');
      this.navItemStash?.setAttribute('aria-selected', 'true');
      this.navItemStash?.setAttribute('tabindex', '0');

      this.navItemSearch?.classList.remove('active');
      this.navItemSearch?.setAttribute('aria-selected', 'false');
      this.navItemSearch?.setAttribute('tabindex', '-1');

      this.btnSidebarSettings?.classList.remove('active');
      this.btnSidebarSettings?.setAttribute('aria-selected', 'false');

      if (updateHash) {
        try {
          history.replaceState(null, '', '#stash');
        } catch {
          // 忽略历史记录异常
        }
      }
      return;
    }

    if (isSearchView) {
      // 1. 激活搜索主视图、隐藏时间线与设置中心
      if (this.tabSearch) {
        this.tabSearch.classList.add('active');
        this.tabSearch.hidden = false;
      }
      if (this.tabStash) {
        this.tabStash.classList.remove('active');
        this.tabStash.hidden = true;
      }
      if (this.viewSettingsHub) {
        this.viewSettingsHub.classList.remove('active');
        this.viewSettingsHub.hidden = true;
      }

      // 2. 侧边栏按钮状态同步
      this.navItemStash?.classList.remove('active');
      this.navItemStash?.setAttribute('aria-selected', 'false');
      this.navItemStash?.setAttribute('tabindex', '-1');

      this.navItemSearch?.classList.add('active');
      this.navItemSearch?.setAttribute('aria-selected', 'true');
      this.navItemSearch?.setAttribute('tabindex', '0');

      this.btnSidebarSettings?.classList.remove('active');
      this.btnSidebarSettings?.setAttribute('aria-selected', 'false');

      // 3. 进入时聚焦搜索框，便于直接输入
      this.components.get('search')?.activate?.();

      if (updateHash) {
        try {
          history.replaceState(null, '', '#search');
        } catch {
          // 忽略历史记录异常
        }
      }
      return;
    }

    // 进入设置中心前，先隐藏搜索主视图
    if (this.tabSearch) {
      this.tabSearch.classList.remove('active');
      this.tabSearch.hidden = true;
    }
    this.navItemSearch?.classList.remove('active');
    this.navItemSearch?.setAttribute('aria-selected', 'false');
    this.navItemSearch?.setAttribute('tabindex', '-1');

    if (targetSubtab) {
      // 进入面板时才实例化并读取数据，避免打开时间线就加载全部隐藏设置页。
      const targetComponent = this.ensureComponent(targetSubtab);
      this.currentSettingsSubtab = targetSubtab;

      if (this.tabStash) {
        this.tabStash.classList.remove('active');
        this.tabStash.hidden = true;
      }
      if (this.viewSettingsHub) {
        this.viewSettingsHub.classList.add('active');
        this.viewSettingsHub.hidden = false;
      }

      // 2. 侧边栏按钮状态同步
      this.navItemStash?.classList.remove('active');
      this.navItemStash?.setAttribute('aria-selected', 'false');
      this.navItemStash?.setAttribute('tabindex', '-1');

      this.btnSidebarSettings?.classList.add('active');
      this.btnSidebarSettings?.setAttribute('aria-selected', 'true');

      // 3. 二级导航 Tab 与面包屑同步
      this.subnavItems.forEach((item) => {
        const isCurrent = item.getAttribute('data-subtab') === targetSubtab;
        item.classList.toggle('active', isCurrent);
        item.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
        item.tabIndex = isCurrent ? 0 : -1;
      });

      if (this.breadcrumbCurrent) {
        this.breadcrumbCurrent.textContent = SETTINGS_SUBTAB_TITLES[targetSubtab] || '设置';
      }

      // 4. 激活对应设置子面板
      this.panels.forEach((panel) => {
        if (panel.id === `tab-${targetSubtab}`) {
          panel.classList.add('active');
          panel.hidden = false;
        } else if (panel.id !== 'tab-stash') {
          panel.classList.remove('active');
          panel.hidden = true;
        }
      });

      // 日志列表需要在面板可见后读取高度并渲染。
      if (targetSubtab === 'logs') {
        targetComponent?.load?.();
      }

      if (updateHash) {
        try {
          history.replaceState(null, '', `#${targetSubtab}`);
        } catch {
          // 忽略历史记录异常
        }
      }
    }
  }
}

// 启动管理中心应用
document.addEventListener('DOMContentLoaded', () => {
  const versionTag = document.getElementById('softwareVersionTag');
  const manifest = chrome.runtime.getManifest?.() || {};
  const softwareVersion = manifest.version_name || manifest.version || '-';
  if (versionTag) versionTag.textContent = `BetterBrowse · ${softwareVersion}`;
  new OptionsApp();
  CustomSelectEnhancer.enhanceAll();
});
