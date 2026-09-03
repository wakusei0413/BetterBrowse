/**
 * @file search-home.js
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




export class SearchHomeComponent {
  constructor() {
    // 搜索引擎跳转地址映射
    this.ENGINES = {
      google:     'https://www.google.com/search?q=',
      baidu:      'https://www.baidu.com/s?wd=',
      bing:       'https://www.bing.com/search?q=',
      duckduckgo: 'https://duckduckgo.com/?q='
    };

    this.currentEngine = 'google';
    this.engineBtns = document.querySelectorAll('#tab-search .search-engine-btn');
    this.searchForm = document.getElementById('searchHomeForm');
    this.searchInput = document.getElementById('searchHomeInput');
    this.initRadioGroup();
    this.bindEvents();
  }

  /**
   * 初始化搜索引擎单选组无障碍属性 (WAI-ARIA Radio Group)
   */
  initRadioGroup() {
    let checkedEngine = null;
    this.engineBtns.forEach((btn) => {
      const isChecked = btn.getAttribute('aria-checked') === 'true' || btn.getAttribute('aria-pressed') === 'true';
      if (isChecked && btn.dataset.engine) {
        checkedEngine = btn.dataset.engine;
      }
    });
    if (checkedEngine) {
      this.currentEngine = checkedEngine;
    }
    this.engineBtns.forEach((btn) => {
      const isSelected = btn.dataset.engine === this.currentEngine;
      btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      btn.tabIndex = isSelected ? 0 : -1;
    });
  }

  /**
   * 切换当前选中的搜索引擎
   * @param {string} engine
   */
  selectEngine(engine) {
    if (!this.ENGINES[engine]) return;
    this.currentEngine = engine;
    this.engineBtns.forEach((b) => {
      const isSelected = b.dataset.engine === engine;
      b.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      b.tabIndex = isSelected ? 0 : -1;
    });
  }

  bindEvents() {
    // 切换搜索引擎与键盘左右/上下键单选组无障碍导航
    this.engineBtns.forEach((btn, index) => {
      btn.addEventListener('click', () => {
        this.selectEngine(btn.dataset.engine);
        this.searchInput?.focus();
      });

      btn.addEventListener('keydown', (e) => {
        const btns = Array.from(this.engineBtns);
        let targetIndex = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          targetIndex = (index + 1) % btns.length;
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          targetIndex = (index - 1 + btns.length) % btns.length;
        }
        if (targetIndex !== -1) {
          const targetBtn = btns[targetIndex];
          this.selectEngine(targetBtn.dataset.engine);
          targetBtn.focus();
        }
      });
    });

    // 提交搜索：在当前标签页打开所选引擎结果页
    this.searchForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = this.searchInput.value.trim();
      if (!query) return;
      const url = this.ENGINES[this.currentEngine] + encodeURIComponent(query);
      chrome.tabs?.create({ url, active: true });
    });

    // / 聚焦搜索框、Esc 清空
    document.addEventListener('keydown', (e) => {
      const panel = document.getElementById('tab-search');
      const isSearchActive = panel && !panel.hidden && panel.classList.contains('active');
      if (!isSearchActive) return;

      if (e.key === '/' && document.activeElement !== this.searchInput) {
        e.preventDefault();
        this.searchInput?.focus();
      } else if (e.key === 'Escape' && document.activeElement === this.searchInput) {
        this.searchInput.value = '';
        this.searchInput.blur();
      }
    });
  }

  /** 进入搜索面板时聚焦输入框，便于直接输入 */
  activate() {
    setTimeout(() => this.searchInput?.focus(), 60);
  }
}
