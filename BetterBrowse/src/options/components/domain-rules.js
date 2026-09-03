/**
 * @file domain-rules.js
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
import { Toast } from './toast.js';
import { CustomSelectEnhancer } from '../ui/custom-select.js';




export class DomainRulesComponent {
  constructor() {
    this.inputDomain = document.getElementById('inputNewDomain');
    this.selectMode = document.getElementById('selectNewDomainMode');
    this.btnAdd = document.getElementById('btnAddDomainRule');
    this.btnClearAll = document.getElementById('btnClearAllDomainRules');
    this.tbody = document.getElementById('domainRulesTbody');
    this.chkGlobalRule = document.getElementById('chkGlobalLinkRule');
    this.selectGlobalMode = document.getElementById('selectGlobalLinkMode');
    this.bannerNotice = document.getElementById('globalOverrideNoticeBanner');

    this.rules = {};
    this.globalRule = { enabled: false, mode: LinkModes.AUTO };

    this.init();
  }

  init() {
    this.bindEvents();
    this.loadRules();
  }

  bindEvents() {
    // 1. 添加新规则
    this.btnAdd?.addEventListener('click', () => this.handleAddRule());
    this.inputDomain?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleAddRule();
    });

    // 2. 清空全部规则
    this.btnClearAll?.addEventListener('click', async () => {
      if (Object.keys(this.rules).length === 0) {
        Toast.show('当前规则列表为空');
        return;
      }
      if (confirm('确定要清空所有已配置的独立网站跳转规则吗？')) {
        const res = await MessageBus.sendToBackground(ActionTypes.CLEAR_DOMAIN_RULES);
        if (res.success) {
          Toast.show('已清空全部域名规则');
          await this.loadRules();
        } else {
          Toast.show(res.error || '清空域名规则失败');
        }
      }
    });

    // 3. 表格内操作事件委托
    this.tbody?.addEventListener('click', async (e) => {
      const btnDelete = e.target.closest('.btn-delete-rule');
      if (btnDelete) {
        const domain = btnDelete.dataset.domain;
        const res = await MessageBus.sendToBackground(ActionTypes.REMOVE_DOMAIN_RULE, { domain });
        if (res.success) {
          Toast.show(`已删除 ${domain} 的跳转规则`);
          await this.loadRules();
        } else {
          Toast.show(res.error || `删除 ${domain} 的跳转规则失败`);
        }
      }
    });

    this.tbody?.addEventListener('change', async (e) => {
      const select = e.target.closest('.table-select-mode');
      if (select) {
        const domain = select.dataset.domain;
        const mode = select.value;
        const res = await MessageBus.sendToBackground(ActionTypes.SET_DOMAIN_RULE, { domain, mode });
        if (res.success) {
          Toast.show(`已更新 ${domain} 跳转行为为 ${mode}`);
          await this.loadRules();
        } else {
          Toast.show(res.error || `更新 ${domain} 跳转行为失败`);
        }
      }
    });

    // 4. 全局覆盖切换
    this.chkGlobalRule?.addEventListener('change', () => this.handleGlobalOverrideChange());
    this.selectGlobalMode?.addEventListener('change', () => this.handleGlobalOverrideChange());
  }

  async loadRules() {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_DOMAIN_RULES);
    if (res.success && res.data) {
      this.rules = res.data;
    }

    const configRes = await MessageBus.sendToBackground(ActionTypes.GET_CONFIG);
    if (configRes.success && configRes.data) {
      this.globalRule = configRes.data.globalLinkRule || { enabled: false, mode: LinkModes.AUTO };
    }

    this.render();
  }

  async handleAddRule() {
    const rawDomain = this.inputDomain?.value.trim();
    const mode = this.selectMode?.value || LinkModes.NEW;

    if (!rawDomain) {
      Toast.show('请输入网站域名');
      this.inputDomain?.focus();
      return;
    }

    const cleanDomain = LinkMatcher.extractDomain(rawDomain);
    if (!cleanDomain) {
      Toast.show('域名格式不正确，请重新输入');
      return;
    }

    const res = await MessageBus.sendToBackground(ActionTypes.SET_DOMAIN_RULE, { domain: cleanDomain, mode });
    if (!res.success) {
      Toast.show(res.error || '添加域名规则失败');
      return;
    }
    Toast.show(`已成功添加 ${cleanDomain} 规则`);
    if (this.inputDomain) this.inputDomain.value = '';
    await this.loadRules();
  }

  async handleGlobalOverrideChange() {
    const enabled = Boolean(this.chkGlobalRule?.checked);
    const mode = this.selectGlobalMode?.value || LinkModes.AUTO;
    this.globalRule = { enabled, mode };

    await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
      globalLinkRule: { enabled, mode }
    });

    this.updateBannerState();
    Toast.show(enabled ? `全局覆盖已启用 (${mode})` : '已恢复各网站独立规则生效');
  }

  updateBannerState() {
    if (this.globalRule.enabled) {
      this.bannerNotice?.classList.remove('hidden');
    } else {
      this.bannerNotice?.classList.add('hidden');
    }
  }

  render() {
    if (this.chkGlobalRule) this.chkGlobalRule.checked = Boolean(this.globalRule.enabled);
    if (this.selectGlobalMode) this.selectGlobalMode.value = this.globalRule.mode || LinkModes.AUTO;
    this.updateBannerState();

    if (!this.tbody) return;
    const domains = Object.keys(this.rules);

    if (domains.length === 0) {
      this.tbody.innerHTML = `
        <tr>
          <td colspan="3" style="text-align: center; color: var(--text-muted); padding: 32px 16px;">
            暂无独立域名规则配置。您可以在上方输入框添加特定网站的跳转偏好，或在网页浏览时直接点击插件图标一键配置。
          </td>
        </tr>
      `;
      return;
    }

    let rowsHtml = '';
    for (const domain of domains) {
      const mode = this.rules[domain];
      const safeDomain = this.escapeHTML(domain);
      rowsHtml += `
        <tr>
          <td><span class="domain-badge">${safeDomain}</span></td>
          <td>
            <select class="form-select table-select-mode btn-sm" data-domain="${safeDomain}" aria-label="修改 ${safeDomain} 跳转行为">
              <option value="new" ${mode === 'new' ? 'selected' : ''}>新标签页打开 (new)</option>
              <option value="current" ${mode === 'current' ? 'selected' : ''}>当前标签打开 (current)</option>
              <option value="auto" ${mode === 'auto' ? 'selected' : ''}>自动模式 (auto)</option>
            </select>
          </td>
          <td style="text-align: right;">
            <button class="btn btn-danger btn-sm btn-delete-rule" data-domain="${safeDomain}" title="删除规则" type="button" aria-label="删除 ${safeDomain} 规则">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
              <span>删除</span>
            </button>
          </td>
        </tr>
      `;
    }
    this.tbody.innerHTML = rowsHtml;
    if (this.tbody) CustomSelectEnhancer.enhanceAll(this.tbody);
    if (this.selectGlobalMode) CustomSelectEnhancer.sync(this.selectGlobalMode);
    if (this.selectMode) CustomSelectEnhancer.sync(this.selectMode);
  }

  escapeHTML(str) {
    if (typeof str !== 'string') return '';
    // 与 StashTabComponent 的实现保持一致（含单引号转义），防止单引号属性场景下的注入
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
}

/**
 * 数据备份、导入与迁移管理组件 (BackupComponent)
 */
