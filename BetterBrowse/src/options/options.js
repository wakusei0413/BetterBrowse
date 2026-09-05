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
import {
  SETTINGS_SUBTAB_TITLES,
  SETTINGS_SUBTABS,
  SETTINGS_TERTIARY_ROUTES
} from './constants.js';
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
    this.breadcrumbParent = document.getElementById('settingsParentSubtabBreadcrumb');
    this.breadcrumbTertiarySeparator = document.getElementById('settingsTertiaryBreadcrumbSeparator');
    this.breadcrumbCurrent = document.getElementById('settingsCurrentSubtabBreadcrumb');
    this.btnBackLabel = this.btnBackToStash?.querySelector('span');
    this.panels = document.querySelectorAll('.tab-panel');

    this.currentSettingsSubtab = 'stash-settings';
    this.currentSettingsRoute = 'stash-settings';

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
    const searchHomeComponent = new SearchHomeComponent({
      onNavigateToStash: (groupId) => {
        this.switchTab('stash');
        if (groupId) {
          this.components.get('stash')?.locateGroup?.(groupId);
        }
      }
    });
    this.components.set('stash', new StashTabComponent());
    this.components.set('search', searchHomeComponent);
    this.components.set('home', searchHomeComponent);
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
        this.components.get('home')?.loadConfig?.();
      } else if (message.action === ActionTypes.NOTIFY_SYNC_UPDATED) {
        this.components.get('sync')?.loadAll?.();
      }
      return false;
    });

    const handleHashNavigation = () => {
      const rawHash = window.location.hash.replace(/^#/, '');
      const [targetTab, queryPart] = (rawHash || 'stash').split('?');
      this.switchTab(targetTab, false);
      if (targetTab === 'stash' && queryPart) {
        const params = new URLSearchParams(queryPart);
        const groupId = params.get('groupId');
        if (groupId) {
          setTimeout(() => this.components.get('stash')?.locateGroup?.(groupId), 100);
        }
      }
    };
    window.addEventListener('hashchange', handleHashNavigation);
    handleHashNavigation();

    window.addEventListener('beforeunload', () => {
      this.components.forEach((comp) => comp?.destroy?.());
    });
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

    // 侧边栏主页按钮点击
    this.navItemSearch?.addEventListener('click', () => {
      this.switchTab('home');
    });

    // 侧边栏左下角系统设置按钮点击（进入统一设置中心）
    this.btnSidebarSettings?.addEventListener('click', () => {
      this.switchTab(this.currentSettingsRoute || this.currentSettingsSubtab || 'stash-settings');
    });

    // 设置中心顶部返回按钮按当前层级返回
    this.btnBackToStash?.addEventListener('click', () => {
      this.navigateBackFromSettings();
    });

    this.breadcrumbParent?.addEventListener('click', () => {
      const targetSubtab = this.breadcrumbParent.dataset.subtab;
      if (targetSubtab) this.switchTab(targetSubtab);
    });

    this.viewSettingsHub?.addEventListener('click', (event) => {
      const routeTrigger = event.target.closest('[data-settings-route]');
      const targetRoute = routeTrigger?.getAttribute('data-settings-route');
      if (targetRoute) this.switchTab(targetRoute);
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

    // 键盘 Esc 快捷键：三级页面先返回父分类，二级页面再返回时间线
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.viewSettingsHub && !this.viewSettingsHub.hidden) {
        const isEditingInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
        if (!isEditingInput) {
          this.navigateBackFromSettings();
        }
      }
    });
  }

  navigateBackFromSettings() {
    const tertiaryRoute = SETTINGS_TERTIARY_ROUTES[this.currentSettingsRoute];
    this.switchTab(tertiaryRoute?.parent || 'stash');
  }

  /**
   * 统一切换视图与设置选项
   * @param {string} tabName 目标标签名或设置路由
   * @param {boolean} [updateHash=true] 是否同步更新 URL Hash
   */
  switchTab(tabName, updateHash = true) {
    if (!tabName) tabName = 'stash';

    const isStashView = tabName === 'stash';
    const isHomeView = tabName === 'search' || tabName === 'home';
    const requestedRoute = tabName === 'settings'
      ? (this.currentSettingsRoute || this.currentSettingsSubtab)
      : tabName;
    const tertiaryRoute = SETTINGS_TERTIARY_ROUTES[requestedRoute];
    const isSettingsSubtab = SETTINGS_SUBTABS.includes(requestedRoute);
    const targetSubtab = tertiaryRoute?.parent || (isSettingsSubtab ? requestedRoute : null);
    const targetRoute = tertiaryRoute ? requestedRoute : targetSubtab;

    // 离开主页视图时释放/暂停定时器与下拉框
    if (!isHomeView) {
      this.components.get('home')?.deactivate?.();
    }

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

    if (isHomeView) {
      // 1. 激活主页视图、隐藏时间线与设置中心
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

      // 3. 进入时激活视图（聚焦搜索框、刷新数据）
      this.components.get('home')?.activate?.();

      if (updateHash) {
        try {
          const targetHash = tabName === 'search' ? '#search' : '#home';
          history.replaceState(null, '', targetHash);
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
      this.currentSettingsRoute = targetRoute;

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

      if (this.breadcrumbParent) {
        this.breadcrumbParent.hidden = !tertiaryRoute;
        this.breadcrumbParent.textContent = SETTINGS_SUBTAB_TITLES[targetSubtab] || '设置';
        this.breadcrumbParent.dataset.subtab = tertiaryRoute ? targetSubtab : '';
      }
      if (this.breadcrumbTertiarySeparator) {
        this.breadcrumbTertiarySeparator.hidden = !tertiaryRoute;
      }
      if (this.breadcrumbCurrent) {
        this.breadcrumbCurrent.textContent = tertiaryRoute?.title || SETTINGS_SUBTAB_TITLES[targetSubtab] || '设置';
      }
      if (this.btnBackLabel) {
        this.btnBackLabel.textContent = tertiaryRoute ? '返回上一级' : '返回';
      }
      this.btnBackToStash?.setAttribute('aria-label', tertiaryRoute ? `返回${SETTINGS_SUBTAB_TITLES[targetSubtab]}` : '返回时间线');

      // 4. 激活对应设置页面
      this.panels.forEach((panel) => {
        if (panel.id === `tab-${targetRoute}`) {
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
          history.replaceState(null, '', `#${targetRoute}`);
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
