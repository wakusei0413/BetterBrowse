/**
 * @file rules-config.js
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




export class RulesConfigComponent {
  constructor() {
    this.dom = {
      inputThreshold: document.getElementById('inputTabThreshold'),
      inputRecent: document.getElementById('inputRecentMinutes'),
      chkAutoStash: document.getElementById('chkAutoStash'),
      inputCountdown: document.getElementById('inputCountdownSeconds'),
      chkAutoNotify: document.getElementById('chkAutoNotify'),
      chkAudible: document.getElementById('chkRuleAudible'),
      chkFormGuard: document.getElementById('chkRuleFormGuard'),
      chkRecentActive: document.getElementById('chkRuleRecentActive'),
      chkHighFrequency: document.getElementById('chkRuleHighFrequency'),
      chkPinned: document.getElementById('chkRulePinned'),
      chkTieredStash: document.getElementById('chkTieredStash'),
      inputTierStepSeconds: document.getElementById('inputTierStepSeconds'),
      inputTierMaxLevels: document.getElementById('inputTierMaxLevels'),
      inputTierSafetyMargin: document.getElementById('inputTierSafetyMargin'),
      chkTierUltimateFallback: document.getElementById('chkTierUltimateFallback'),
      rowTierStepSeconds: document.getElementById('rowTierStepSeconds'),
      rowTierMaxLevels: document.getElementById('rowTierMaxLevels'),
      rowTierSafetyMargin: document.getElementById('rowTierSafetyMargin'),
      rowTierUltimateFallback: document.getElementById('rowTierUltimateFallback'),
      tieredStrategySummary: document.getElementById('tieredStrategySummary'),
      autoSaveIndicator: document.getElementById('rulesAutoSaveIndicator'),
      tieredAutoSaveIndicator: document.getElementById('tieredAutoSaveIndicator')
    };

    this.saveDebounceTimer = null;
    this.init();
  }

  init() {
    this.loadConfig();
    this.bindEvents();
  }

  async loadConfig() {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_CONFIG);
    if (!res.success || !res.data) return;

    const config = res.data;
    if (this.dom.inputThreshold) this.dom.inputThreshold.value = config.tabThreshold || 15;
    if (this.dom.inputRecent) this.dom.inputRecent.value = config.recentActiveMinutes || 5;
    if (this.dom.chkAutoStash) this.dom.chkAutoStash.checked = Boolean(config.autoStashOnThreshold);
    if (this.dom.inputCountdown) this.dom.inputCountdown.value = config.countdownSeconds || 15;
    if (this.dom.chkAutoNotify) this.dom.chkAutoNotify.checked = Boolean(config.autoThresholdNotify);

    const rules = config.rulesEnabled || {};
    if (this.dom.chkAudible) this.dom.chkAudible.checked = rules.audible !== false;
    if (this.dom.chkFormGuard) this.dom.chkFormGuard.checked = rules.formGuard !== false;
    if (this.dom.chkRecentActive) this.dom.chkRecentActive.checked = rules.recentActive !== false;
    if (this.dom.chkHighFrequency) this.dom.chkHighFrequency.checked = rules.highFrequency !== false;
    if (this.dom.chkPinned) this.dom.chkPinned.checked = rules.pinned !== false;

    // 阶梯式降级收纳配置
    const tiered = config.tieredStash || {};
    if (this.dom.chkTieredStash) this.dom.chkTieredStash.checked = tiered.enabled !== false;
    if (this.dom.inputTierStepSeconds) this.dom.inputTierStepSeconds.value = Number.isFinite(tiered.tierStepSeconds) ? tiered.tierStepSeconds : 60;
    if (this.dom.inputTierMaxLevels) this.dom.inputTierMaxLevels.value = Number.isFinite(tiered.maxTiers) ? tiered.maxTiers : 5;
    if (this.dom.inputTierSafetyMargin) this.dom.inputTierSafetyMargin.value = Number.isFinite(tiered.targetSafetyMargin) ? tiered.targetSafetyMargin : 0;
    if (this.dom.chkTierUltimateFallback) this.dom.chkTierUltimateFallback.checked = tiered.ultimateFallback !== false;
    this.updateTieredRowsState();
    this.updateTieredSummary();
  }

  updateTieredSummary() {
    if (!this.dom.tieredStrategySummary) return;
    if (!this.dom.chkTieredStash?.checked) {
      this.dom.tieredStrategySummary.textContent = '当前已关闭，仅执行标准保护规则';
      return;
    }
    const maxTiers = Math.max(0, parseInt(this.dom.inputTierMaxLevels?.value, 10) || 0);
    const stepSeconds = Math.max(1, parseInt(this.dom.inputTierStepSeconds?.value, 10) || 60);
    this.dom.tieredStrategySummary.textContent = `已启用 · 最多 ${maxTiers} 轮 · 每轮缩短 ${stepSeconds} 秒`;
  }

  /**
   * 根据阶梯总开关联动显示/隐藏下级参数行
   */
  updateTieredRowsState() {
    const enabled = Boolean(this.dom.chkTieredStash?.checked);
    const rows = [
      this.dom.rowTierStepSeconds,
      this.dom.rowTierMaxLevels,
      this.dom.rowTierSafetyMargin,
      this.dom.rowTierUltimateFallback
    ];
    for (const row of rows) {
      if (!row) continue;
      row.classList.toggle('setting-item--disabled', !enabled);
    }
  }

  bindEvents() {
    const inputs = [
      this.dom.inputThreshold,
      this.dom.inputRecent,
      this.dom.chkAutoStash,
      this.dom.inputCountdown,
      this.dom.chkAutoNotify,
      this.dom.chkAudible,
      this.dom.chkFormGuard,
      this.dom.chkRecentActive,
      this.dom.chkHighFrequency,
      this.dom.chkPinned,
      this.dom.chkTieredStash,
      this.dom.inputTierStepSeconds,
      this.dom.inputTierMaxLevels,
      this.dom.inputTierSafetyMargin,
      this.dom.chkTierUltimateFallback
    ];

    inputs.forEach((el) => {
      if (!el) return;
      el.addEventListener('change', () => {
        this.updateTieredRowsState();
        this.updateTieredSummary();
        this.saveConfig();
      });
      if (el.type === 'number') {
        el.addEventListener('input', () => {
          this.updateTieredSummary();
          this.saveConfig();
        });
      }
    });
  }

  async saveConfig() {
    clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(async () => {
      const tabThreshold = parseInt(this.dom.inputThreshold?.value, 10) || 15;
      const recentActiveMinutes = parseInt(this.dom.inputRecent?.value, 10) || 5;
      const autoStashOnThreshold = Boolean(this.dom.chkAutoStash?.checked);
      const countdownSeconds = parseInt(this.dom.inputCountdown?.value, 10) || 15;
      const autoThresholdNotify = Boolean(this.dom.chkAutoNotify?.checked);

      const rulesEnabled = {
        audible: Boolean(this.dom.chkAudible?.checked),
        formGuard: Boolean(this.dom.chkFormGuard?.checked),
        recentActive: Boolean(this.dom.chkRecentActive?.checked),
        highFrequency: Boolean(this.dom.chkHighFrequency?.checked),
        pinned: Boolean(this.dom.chkPinned?.checked)
      };

      const tieredStash = {
        enabled: Boolean(this.dom.chkTieredStash?.checked),
        tierStepSeconds: Math.max(1, parseInt(this.dom.inputTierStepSeconds?.value, 10) || 60),
        maxTiers: Math.max(0, parseInt(this.dom.inputTierMaxLevels?.value, 10) || 5),
        targetSafetyMargin: Math.max(0, parseInt(this.dom.inputTierSafetyMargin?.value, 10) || 0),
        ultimateFallback: Boolean(this.dom.chkTierUltimateFallback?.checked)
      };

      const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
        tabThreshold,
        recentActiveMinutes,
        autoStashOnThreshold,
        countdownSeconds,
        autoThresholdNotify,
        rulesEnabled,
        tieredStash
      });

      if (res.success) {
        this.flashSaveIndicator();
      }
    }, 200);
  }

  flashSaveIndicator() {
    const indicators = [this.dom.autoSaveIndicator, this.dom.tieredAutoSaveIndicator].filter(Boolean);
    for (const indicator of indicators) indicator.classList.add('visible');
    setTimeout(() => {
      for (const indicator of indicators) indicator.classList.remove('visible');
    }, 2000);
  }
}

/**
 * 域名跳转规则管理组件 (DomainRulesComponent)
 */
