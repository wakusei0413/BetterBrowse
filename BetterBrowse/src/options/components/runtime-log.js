/**
 * @file runtime-log.js
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




export class RuntimeLogComponent {
  constructor() {
    this.$level = document.getElementById('runtimeLogLevel');
    this.$source = document.getElementById('runtimeLogSource');
    this.$keyword = document.getElementById('runtimeLogKeyword');
    this.$count = document.getElementById('runtimeLogCount');
    this.$list = document.getElementById('runtimeLogList');
    this.$refresh = document.getElementById('btnRuntimeLogRefresh');
    this.$clear = document.getElementById('btnRuntimeLogClear');
    this.searchTimer = null;
    this.bind();
  }

  bind() {
    this.$level?.addEventListener('change', () => this.load());
    this.$source?.addEventListener('change', () => this.load());
    this.$keyword?.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.load(), 180);
    });
    this.$refresh?.addEventListener('click', () => this.load());
    this.$clear?.addEventListener('click', () => this.clear());
    CustomSelectEnhancer.enhanceAll(document.getElementById('tab-logs'));
  }

  async load() {
    const res = await MessageBus.sendToBackground(ActionTypes.QUERY_RUNTIME_LOGS, {
      level: this.$level?.value || '',
      source: this.$source?.value || '',
      keyword: this.$keyword?.value || '',
      limit: 1000
    });
    if (!res?.success || !res.data) {
      this.render([]);
      if (this.$count) this.$count.textContent = res?.error || '读取失败';
      return;
    }
    this.updateSources(res.data.sources || []);
    this.render(res.data.entries || []);
    if (this.$count) this.$count.textContent = `${res.data.total || 0} 条记录`;
  }

  updateSources(sources) {
    if (!this.$source) return;
    const selected = this.$source.value;
    this.$source.replaceChildren(new Option('全部来源', ''));
    for (const source of sources) this.$source.add(new Option(source, source));
    this.$source.value = sources.includes(selected) ? selected : '';
    CustomSelectEnhancer.sync(this.$source);
  }

  render(entries) {
    if (!this.$list) return;
    this.$list.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sync-empty';
      empty.textContent = '暂无符合条件的运行日志';
      this.$list.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'runtime-log-row';
      row.dataset.level = entry.level;

      const time = document.createElement('time');
      time.textContent = entry.ts ? new Date(entry.ts).toLocaleString('zh-CN') : '-';
      const level = document.createElement('span');
      level.className = 'runtime-log-level';
      level.textContent = ({ error: '错误', warn: '警告', info: '信息', debug: '调试' })[entry.level] || entry.level;
      const source = document.createElement('span');
      source.className = 'runtime-log-source';
      source.textContent = entry.source || '-';
      const message = document.createElement('code');
      message.className = 'runtime-log-message';
      message.textContent = entry.message || '-';
      row.append(time, level, source, message);
      fragment.appendChild(row);
    }
    this.$list.appendChild(fragment);
  }

  async clear() {
    if (!window.confirm('确定清空全部运行日志和 AI 操作审计吗？此操作不可撤销。')) return;
    const res = await MessageBus.sendToBackground(ActionTypes.CLEAR_RUNTIME_LOGS, { confirm: true });
    const ok = res?.success && res.data?.success !== false;
    Toast.show(ok ? '运行日志已清空' : (res?.data?.error || res?.error || '清空失败'));
    if (ok) await this.load();
  }
}

/**
 * 关于面板组件 (AboutComponent)
 */
