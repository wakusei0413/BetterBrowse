/**
 * @file stash-settings.js
 * @description 选项页组件模块
 * @encoding UTF-8
 */


import { ActionTypes } from '../../constants/action-types.js';
import { StorageKeys } from '../../constants/storage-keys.js';
import { LinkModes, LOCAL_DATA_SCHEMA_REVISION } from '../../constants/config.js';
import { API_VERSION } from '../../constants/api-version.js';
import { LinkMatcher } from '../../core/link/link-matcher.js';
import { MessageBus } from '../../core/bus/message-bus.js';
import { installRuntimeLogger } from '../../core/logging/runtime-logger.js';
import {
  GROUP_OVERSCAN,
  TAB_OVERSCAN,
  TABS_INITIAL_LIMIT,
  computePads,
  estimateGroupCardHeight,
  getDensityMetrics,
  getItemWindow,
  getVisibleRange
} from '../list-window.js';
import { CustomSelectEnhancer } from '../ui/custom-select.js';




export class StashSettingsComponent {
  constructor() {
    this.dom = {
      selectRestoreBehavior: document.getElementById('selectRestoreBehavior'),
      selectRestorePosition: document.getElementById('selectRestorePosition'),
      chkAllowDuplicates: document.getElementById('chkAllowDuplicates'),
      selectExistingTabTitle: document.getElementById('selectExistingTabTitle'),
      chkAutoOpenStashTab: document.getElementById('chkAutoOpenStashTab'),
      chkPinnedTabGuard: document.getElementById('chkPinnedTabGuard'),
      chkDeleteConfirmation: document.getElementById('chkDeleteConfirmation'),
      selectDisplayDensity: document.getElementById('selectDisplayDensity'),
      chkAutoBackupEnabled: document.getElementById('chkAutoBackupEnabled'),
      selectBackupRetentionDays: document.getElementById('selectBackupRetentionDays'),
      autoSaveIndicator: document.getElementById('stashSettingsAutoSaveIndicator')
    };

    this.saveDebounceTimer = null;
    this.init();
  }

  init() {
    this.loadSettings();
    this.bindEvents();
  }

  async loadSettings() {
    const configRes = await MessageBus.sendToBackground(ActionTypes.GET_CONFIG);
    const config = configRes.success && configRes.data ? configRes.data : {};
    const settings = config.stashSettings || {};
    document.documentElement.dataset.displayDensity = settings.displayDensity || 'comfortable';

    if (this.dom.selectRestoreBehavior) {
      this.dom.selectRestoreBehavior.value = settings.restoreBehavior || 'remove';
    }
    if (this.dom.selectRestorePosition) {
      this.dom.selectRestorePosition.value = settings.restorePosition || 'currentWindow';
    }
    if (this.dom.chkAllowDuplicates) {
      this.dom.chkAllowDuplicates.checked = settings.allowDuplicates !== false;
    }
    if (this.dom.selectExistingTabTitle) {
      this.dom.selectExistingTabTitle.value = settings.existingTabTitleBehavior || 'useOriginal';
    }
    if (this.dom.chkAutoOpenStashTab) {
      this.dom.chkAutoOpenStashTab.checked = settings.autoOpenStashTab !== false;
    }
    if (this.dom.chkPinnedTabGuard) {
      this.dom.chkPinnedTabGuard.checked = settings.pinnedTabGuard !== false;
    }
    if (this.dom.chkDeleteConfirmation) {
      this.dom.chkDeleteConfirmation.checked = settings.deleteConfirmation !== false;
    }
    if (this.dom.selectDisplayDensity) {
      this.dom.selectDisplayDensity.value = settings.displayDensity || 'comfortable';
    }
    if (this.dom.chkAutoBackupEnabled) {
      this.dom.chkAutoBackupEnabled.checked = settings.autoBackupEnabled !== false;
    }
    if (this.dom.selectBackupRetentionDays) {
      this.dom.selectBackupRetentionDays.value = String(settings.backupRetentionDays || 30);
    }
    CustomSelectEnhancer.enhanceAll(document.getElementById('tab-settings'));
  }

  bindEvents() {
    const controls = [
      this.dom.selectRestoreBehavior,
      this.dom.selectRestorePosition,
      this.dom.chkAllowDuplicates,
      this.dom.selectExistingTabTitle,
      this.dom.chkAutoOpenStashTab,
      this.dom.chkPinnedTabGuard,
      this.dom.chkDeleteConfirmation,
      this.dom.selectDisplayDensity,
      this.dom.chkAutoBackupEnabled,
      this.dom.selectBackupRetentionDays
    ];

    controls.forEach((ctrl) => {
      if (!ctrl) return;
      ctrl.addEventListener('change', () => this.saveSettings());
    });
  }

  async saveSettings() {
    clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(async () => {
      const stashSettings = {
        restoreBehavior: this.dom.selectRestoreBehavior?.value || 'remove',
        restorePosition: this.dom.selectRestorePosition?.value || 'currentWindow',
        allowDuplicates: Boolean(this.dom.chkAllowDuplicates?.checked),
        existingTabTitleBehavior: this.dom.selectExistingTabTitle?.value || 'useOriginal',
        autoOpenStashTab: Boolean(this.dom.chkAutoOpenStashTab?.checked),
        pinnedTabGuard: Boolean(this.dom.chkPinnedTabGuard?.checked),
        deleteConfirmation: Boolean(this.dom.chkDeleteConfirmation?.checked),
        displayDensity: this.dom.selectDisplayDensity?.value || 'comfortable',
        autoBackupEnabled: Boolean(this.dom.chkAutoBackupEnabled?.checked),
        backupRetentionDays: parseInt(this.dom.selectBackupRetentionDays?.value || '30', 10)
      };

      const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
        stashSettings
      });

      if (res.success) {
        document.documentElement.dataset.displayDensity = stashSettings.displayDensity;
        this.flashSaveIndicator();
      }
    }, 150);
  }

  flashSaveIndicator() {
    if (!this.dom.autoSaveIndicator) return;
    this.dom.autoSaveIndicator.classList.add('visible');
    setTimeout(() => {
      this.dom.autoSaveIndicator.classList.remove('visible');
    }, 2000);
  }
}

/**
 * 智能收纳规则配置组件 (RulesConfigComponent)
 */
