/**
 * @file home-view.js
 * @description BetterBrowse 主页与新标签页共享核心视图控制器
 * 支持外部联想（Google/Bing，需主动同意）、本地收纳分页检索、optional history 搜索与推荐、
 * 当前窗口/收纳统计与近期收纳快速跳转。
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { MessageBus } from '../core/bus/message-bus.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';

/** 默认搜索引擎地址映射 */
const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q='
};

/** 引擎显示名 */
const ENGINE_NAMES = {
  google: 'Google',
  baidu: '百度',
  bing: 'Bing',
  duckduckgo: 'DuckDuckGo'
};

export class HomeView {
  /**
   * @param {object} options
   * @param {HTMLElement} options.container - 挂载容器元素
   * @param {'current' | 'new'} [options.openTarget='current'] - 链接打开目标（独立新标签页用 current，管理中心用 new）
   * @param {boolean} [options.isStandalone=false] - 是否为独立新标签页环境
   * @param {() => void} [options.onNavigateToStash] - 管理中心内跳转到时间线的回调
   */
  constructor(options = {}) {
    this.container = options.container;
    this.openTarget = options.openTarget || 'current';
    this.isStandalone = Boolean(options.isStandalone);
    this.onNavigateToStash = options.onNavigateToStash || null;

    // 状态管理
    this.config = null;
    this.currentEngine = 'google';
    this.hasHistoryPermission = false;
    this.searchSeq = 0;
    this.debounceTimer = null;
    this.isComposing = false;
    this.activeOptionIndex = -1;
    this.currentOptions = []; // 当前下拉列表中可选的项

    // 收纳分页游标缓存
    this.stashNextCursor = null;
    this.lastSearchQuery = '';

    // 事件解绑清理器列表
    this._cleanups = [];

    this.init();
  }

  /**
   * 初始化主页 DOM 骨架与事件
   */
  async init() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="bb-home-container">
        <!-- 头部品牌与统计药丸 -->
        <header class="bb-home-header">
          <div class="bb-home-brand">
            <img src="${this.getIconUrl(48)}" alt="BetterBrowse Logo" class="bb-home-logo-img" />
            <h1 class="bb-home-title">BetterBrowse<span class="bb-home-dot">.</span></h1>
          </div>
          <div class="bb-home-stats-pill" id="homeStatsPill" aria-label="运行状态概览">
            <span class="stat-item">
              <span>当前窗口:</span>
              <span class="stat-highlight" id="homeStatWindowTabs">-</span>
              <span id="homeStatThresholdLabel">/ - 标签</span>
            </span>
            <span class="stat-sep"></span>
            <span class="stat-item">
              <span>已收纳:</span>
              <span class="stat-highlight" id="homeStatTotalGroups">-</span>
              <span>组</span>
              <span class="stat-highlight" id="homeStatTotalItems">-</span>
              <span>页面</span>
            </span>
          </div>
        </header>

        <!-- 搜索主舞台 -->
        <section class="bb-home-search-stage" aria-label="网页搜索">
          <!-- 搜索引擎切换按钮组 -->
          <div class="bb-home-engine-tabs" role="tablist" aria-label="搜索引擎选择">
            <button type="button" class="bb-home-engine-btn active" data-engine="google" role="tab" aria-selected="true">Google</button>
            <button type="button" class="bb-home-engine-btn" data-engine="bing" role="tab" aria-selected="false">Bing</button>
            <button type="button" class="bb-home-engine-btn" data-engine="baidu" role="tab" aria-selected="false">百度</button>
            <button type="button" class="bb-home-engine-btn" data-engine="duckduckgo" role="tab" aria-selected="false">DuckDuckGo</button>
          </div>

          <!-- 组合输入框 (WAI-ARIA Combobox) -->
          <div class="bb-home-search-box">
            <svg class="bb-home-search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              type="text"
              id="homeSearchInput"
              class="bb-home-search-input"
              placeholder="输入关键词搜索网页、已收纳标签或历史记录..."
              autocomplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="false"
              aria-controls="homeComboboxDropdown"
              aria-haspopup="listbox"
            />
            <div class="bb-home-search-actions">
              <button type="button" id="btnHomeSearchClear" class="bb-home-btn-icon bb-hidden" title="清空" aria-label="清空输入框">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
              <button type="button" id="btnHomeSearchSubmit" class="bb-home-btn-submit">搜索</button>
            </div>
          </div>

          <!-- 联想建议与聚合结果下拉列表 -->
          <div id="homeComboboxDropdown" class="bb-home-combobox-dropdown bb-hidden" role="listbox" aria-label="搜索建议与本地检索">
            <div id="homeSuggestGroup" class="bb-home-dropdown-group bb-hidden">
              <div class="bb-home-dropdown-header">
                <span id="homeSuggestHeaderTitle">搜索联想</span>
              </div>
              <div id="homeSuggestList"></div>
            </div>

            <div id="homeStashGroup" class="bb-home-dropdown-group bb-hidden">
              <div class="bb-home-dropdown-header">
                <span>已收纳页面</span>
              </div>
              <div id="homeStashList"></div>
              <button type="button" id="btnHomeLoadMoreStash" class="bb-home-load-more-btn bb-hidden">加载更多收纳匹配</button>
            </div>

            <div id="homeHistoryGroup" class="bb-home-dropdown-group bb-hidden">
              <div class="bb-home-dropdown-header">
                <span>历史记录</span>
              </div>
              <div id="homeHistoryList"></div>
            </div>
          </div>

          <!-- 外部联想同意确认通知栏 -->
          <div id="homeSuggestConsentCard" class="bb-home-consent-card bb-hidden" role="region" aria-label="联想建议授权提示">
            <span>开启外部联想？BetterBrowse 会将输入内容发送给 Google/Bing 以获取实时建议（搜索词不审计且不带凭据）。</span>
            <div class="bb-home-consent-btns">
              <button type="button" id="btnHomeAgreeSuggest" class="bb-btn-sm bb-btn-primary">同意并开启</button>
              <button type="button" id="btnHomeDeclineSuggest" class="bb-btn-sm bb-btn-secondary">保持关闭</button>
            </div>
          </div>
        </section>

        <!-- 主页偏好设置轻量折叠面板 -->
        <details class="bb-home-pref-panel" id="homePrefPanel">
          <summary class="bb-home-pref-summary">
            <span class="bb-home-pref-summary-title">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
              <span>主页展示偏好</span>
            </span>
            <span id="homePrefFeedback" class="bb-home-pref-feedback bb-hidden" role="status"></span>
            <svg class="bb-home-pref-summary-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </summary>
          <div class="bb-home-pref-body">
            <label class="bb-home-pref-checkbox-label">
              <input type="checkbox" id="chkShowWindowTabStats" checked />
              <span>显示当前窗口标签与阈值统计</span>
            </label>
            <label class="bb-home-pref-checkbox-label">
              <input type="checkbox" id="chkShowRecentStash" checked />
              <span>显示近期收纳模块</span>
            </label>
            <label class="bb-home-pref-checkbox-label">
              <input type="checkbox" id="chkShowHistoryRecommendations" checked />
              <span>显示历史记录推荐模块</span>
            </label>
            <div class="bb-home-pref-hint">
              <span>提示：默认搜索引擎直接点击上方 Tab 即可自动保存。</span>
            </div>
          </div>
        </details>

        <!-- 下方内容网格：近期收纳 + 历史推荐 -->
        <main class="bb-home-grid">
          <!-- 卡片 1: 近期收纳 (不删除条目，直接访问) -->
          <section class="bb-home-section-card" id="homeRecentStashCard" aria-labelledby="homeRecentStashTitle">
            <div class="bb-home-section-header">
              <div class="bb-home-section-title-wrap">
                <svg class="bb-home-section-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path>
                  <path d="m3.3 7 8.7 5 8.7-5"></path>
                  <path d="M12 22V12"></path>
                </svg>
                <h2 id="homeRecentStashTitle" class="bb-home-section-title">近期收纳</h2>
              </div>
              <a href="#" id="homeLinkAllStash" class="bb-home-section-link">全部时间线 &rarr;</a>
            </div>
            <div id="homeRecentStashList" class="bb-home-list">
              <div class="bb-home-empty">
                <span>正在加载近期收纳...</span>
              </div>
            </div>
          </section>

          <!-- 卡片 2: 浏览历史推荐 (最近访问 + 常访推荐；标注候选范围和 visitCount 访问次数) -->
          <section class="bb-home-section-card" id="homeHistoryCard" aria-labelledby="homeHistoryTitle">
            <div class="bb-home-section-header">
              <div class="bb-home-section-title-wrap">
                <svg class="bb-home-section-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <h2 id="homeHistoryTitle" class="bb-home-section-title">历史推荐</h2>
              </div>
              <button type="button" id="btnHomeRevokeHistory" class="bb-home-section-link bb-hidden" title="撤销历史记录权限">撤销权限</button>
            </div>
            <div id="homeHistoryContainer" class="bb-home-list">
              <!-- 动态装载历史权限引导卡片或推荐列表 -->
              <div class="bb-home-empty">
                <span>正在查询历史记录状态...</span>
              </div>
            </div>
          </section>
        </main>
      </div>
    `;

    this.bindDomElements();
    this.bindEvents();
    await this.loadConfig();
    await this.refreshAll();
  }

  /**
   * 绑定 DOM 引用
   */
  bindDomElements() {
    this.input = this.container.querySelector('#homeSearchInput');
    this.btnClear = this.container.querySelector('#btnHomeSearchClear');
    this.btnSubmit = this.container.querySelector('#btnHomeSearchSubmit');
    this.engineBtns = this.container.querySelectorAll('.bb-home-engine-btn');
    this.dropdown = this.container.querySelector('#homeComboboxDropdown');
    this.suggestGroup = this.container.querySelector('#homeSuggestGroup');
    this.suggestList = this.container.querySelector('#homeSuggestList');
    this.suggestHeaderTitle = this.container.querySelector('#homeSuggestHeaderTitle');
    this.stashGroup = this.container.querySelector('#homeStashGroup');
    this.stashList = this.container.querySelector('#homeStashList');
    this.btnLoadMoreStash = this.container.querySelector('#btnHomeLoadMoreStash');
    this.historyGroup = this.container.querySelector('#homeHistoryGroup');
    this.historyList = this.container.querySelector('#homeHistoryList');
    this.consentCard = this.container.querySelector('#homeSuggestConsentCard');
    this.btnAgreeSuggest = this.container.querySelector('#btnHomeAgreeSuggest');
    this.btnDeclineSuggest = this.container.querySelector('#btnHomeDeclineSuggest');
    this.statsWindowTabs = this.container.querySelector('#homeStatWindowTabs');
    this.statsThresholdLabel = this.container.querySelector('#homeStatThresholdLabel');
    this.statsTotalGroups = this.container.querySelector('#homeStatTotalGroups');
    this.statsTotalItems = this.container.querySelector('#homeStatTotalItems');
    this.recentStashList = this.container.querySelector('#homeRecentStashList');
    this.historyContainer = this.container.querySelector('#homeHistoryContainer');
    this.btnRevokeHistory = this.container.querySelector('#btnHomeRevokeHistory');
    this.linkAllStash = this.container.querySelector('#homeLinkAllStash');
    this.statsPill = this.container.querySelector('#homeStatsPill');
    this.recentStashCard = this.container.querySelector('#homeRecentStashCard');
    this.historyCard = this.container.querySelector('#homeHistoryCard');
    this.homeGrid = this.container.querySelector('.bb-home-grid');
    this.prefPanel = this.container.querySelector('#homePrefPanel');
    this.prefFeedback = this.container.querySelector('#homePrefFeedback');
    this.chkStats = this.container.querySelector('#chkShowWindowTabStats');
    this.chkRecentStash = this.container.querySelector('#chkShowRecentStash');
    this.chkHistory = this.container.querySelector('#chkShowHistoryRecommendations');
  }

  /**
   * 同步偏好设置面板的复选框勾选状态
   */
  syncCheckboxStates() {
    const home = this.config?.home || {};
    if (this.chkStats) this.chkStats.checked = home.showWindowTabStats !== false;
    if (this.chkRecentStash) this.chkRecentStash.checked = home.showRecentStash !== false;
    if (this.chkHistory) this.chkHistory.checked = home.showHistoryRecommendations !== false;
  }

  /**
   * 应用模块可见性偏好（当前窗口统计、近期收纳卡片、历史推荐卡片）
   */
  applyModulePreferences() {
    const home = this.config?.home || {};
    const showStats = home.showWindowTabStats !== false;
    const showRecent = home.showRecentStash !== false;
    const showHistory = home.showHistoryRecommendations !== false;

    if (this.statsPill) this.statsPill.classList.toggle('bb-hidden', !showStats);
    if (this.recentStashCard) this.recentStashCard.classList.toggle('bb-hidden', !showRecent);
    if (this.historyCard) this.historyCard.classList.toggle('bb-hidden', !showHistory);
    if (this.homeGrid) this.homeGrid.classList.toggle('bb-hidden', !showRecent && !showHistory);
  }

  /**
   * 绑定界面交互事件
   */
  bindEvents() {
    const addListener = (element, event, handler) => {
      if (!element) return;
      element.addEventListener(event, handler);
      this._cleanups.push(() => element.removeEventListener(event, handler));
    };

    // 1. 搜索引擎切换
    this.engineBtns.forEach((btn) => {
      addListener(btn, 'click', () => {
        const engine = btn.dataset.engine;
        if (engine && SEARCH_ENGINES[engine]) {
          this.setEngine(engine);
          this.input?.focus();
        }
      });
    });

    // 2. 搜索输入防抖、IME 组合与清空
    addListener(this.input, 'compositionstart', () => {
      this.isComposing = true;
    });

    addListener(this.input, 'compositionend', () => {
      this.isComposing = false;
      this.scheduleSearch();
    });

    addListener(this.input, 'input', () => {
      if (this.btnClear) {
        this.btnClear.classList.toggle('bb-hidden', !this.input.value);
      }
      if (this.isComposing) return;
      this.scheduleSearch();
    });

    addListener(this.btnClear, 'click', () => {
      if (this.input) {
        this.input.value = '';
        this.input.focus();
      }
      this.btnClear?.classList.add('bb-hidden');
      this.closeDropdown();
    });

    // 3. 键盘 Combobox 导航（ArrowUp/Down, Enter, Escape, 修饰键与输入法保护）
    addListener(this.input, 'keydown', (e) => {
      if (this.isComposing || e.isComposing || e.keyCode === 229) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveActiveOption(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveActiveOption(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.handleEnterKey(e);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeDropdown();
      }
    });

    // 4. 点击搜索按钮（支持修饰键新标签页打开）
    addListener(this.btnSubmit, 'click', (e) => {
      this.submitWebSearch(this.input.value.trim(), Boolean(e?.ctrlKey || e?.metaKey));
    });

    // 5. 点击其他区域关闭下拉层
    const handleDocumentClick = (e) => {
      if (!this.container?.contains(e.target)) {
        this.closeDropdown();
      }
    };
    document.addEventListener('click', handleDocumentClick);
    this._cleanups.push(() => document.removeEventListener('click', handleDocumentClick));

    // 6. 收纳加载更多
    addListener(this.btnLoadMoreStash, 'click', (e) => {
      e.stopPropagation();
      this.loadMoreStashResults();
    });

    // 7. 外部联想同意流程（拒绝时立即清空并收起已有建议）
    addListener(this.btnAgreeSuggest, 'click', async () => {
      await this.setExternalSuggestAgreed(true);
      this.consentCard?.classList.add('bb-hidden');
      this.scheduleSearch(0);
    });

    addListener(this.btnDeclineSuggest, 'click', async () => {
      await this.setExternalSuggestAgreed(false);
      this.consentCard?.classList.add('bb-hidden');
      if (this.suggestGroup) {
        this.suggestGroup.classList.add('bb-hidden');
        if (this.suggestList) this.suggestList.innerHTML = '';
      }
    });

    // 8. 撤销历史权限
    addListener(this.btnRevokeHistory, 'click', async () => {
      await this.revokeHistoryPermission();
    });

    // 9. 全部时间线跳转
    addListener(this.linkAllStash, 'click', (e) => {
      e.preventDefault();
      this.navigateToStash();
    });

    // 10. 监听后台配置与偏好更新通知，即时响应模块开关变更
    const handleRuntimeMessage = (message) => {
      if (message?.action === ActionTypes.NOTIFY_CONFIG_UPDATED) {
        this.loadConfig().then(() => this.refreshAll()).catch(() => {});
      }
    };
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleRuntimeMessage);
      this._cleanups.push(() => {
        try {
          chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
        } catch {}
      });
    }

    // 11. 主页模块偏好复选框切换（通过 UPDATE_CONFIG 统一持久化与广播）
    addListener(this.chkStats, 'change', () => {
      this.updateModulePreference('showWindowTabStats', this.chkStats.checked, this.chkStats);
    });
    addListener(this.chkRecentStash, 'change', () => {
      this.updateModulePreference('showRecentStash', this.chkRecentStash.checked, this.chkRecentStash);
    });
    addListener(this.chkHistory, 'change', () => {
      this.updateModulePreference('showHistoryRecommendations', this.chkHistory.checked, this.chkHistory);
    });
  }

  /**
   * 加载用户偏好
   */
  async loadConfig() {
    try {
      this.config = await StorageAdapter.getUserConfig();
      if (this.config?.home?.searchEngine && SEARCH_ENGINES[this.config.home.searchEngine]) {
        this.setEngine(this.config.home.searchEngine, false);
      }
      this.syncCheckboxStates();
    } catch {
      this.config = null;
    }
  }

  /**
   * 更新主页模块展示偏好（调用 UPDATE_CONFIG 保证持久化，失败自动回滚并提示）
   * @param {string} key
   * @param {boolean} value
   * @param {HTMLInputElement} [checkboxEl]
   */
  async updateModulePreference(key, value, checkboxEl) {
    try {
      const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
        home: {
          ...(this.config?.home || {}),
          [key]: value
        }
      });
      if (!res) throw new Error('配置更新未成功');
      if (this.config) {
        this.config.home = {
          ...(this.config.home || {}),
          [key]: value
        };
      }
      this.applyModulePreferences();
      this.showPrefFeedback('偏好已保存', 'success');
    } catch (err) {
      if (checkboxEl) checkboxEl.checked = !value;
      this.showPrefFeedback(`保存失败: ${err?.message || '配置更新异常'}`, 'error');
    }
  }

  /**
   * 展示偏好面板轻量状态反馈提示
   * @param {string} text
   * @param {'success'|'error'} [type='success']
   */
  showPrefFeedback(text, type = 'success') {
    if (!this.prefFeedback) return;
    clearTimeout(this.prefFeedbackTimer);
    this.prefFeedback.textContent = text;
    this.prefFeedback.className = `bb-home-pref-feedback ${type}`;
    this.prefFeedback.classList.remove('bb-hidden');
    this.prefFeedbackTimer = setTimeout(() => {
      this.prefFeedback?.classList.add('bb-hidden');
    }, 2500);
  }

  /**
   * 刷新整个主页数据（统计、近期收纳、历史权限与推荐；遵循模块偏好开关）
   */
  async refreshAll() {
    this.applyModulePreferences();
    const home = this.config?.home || {};
    const tasks = [];
    if (home.showWindowTabStats !== false) tasks.push(this.refreshStats());
    if (home.showRecentStash !== false) tasks.push(this.refreshRecentStash());
    if (home.showHistoryRecommendations !== false) tasks.push(this.refreshHistorySection());
    await Promise.allSettled(tasks);
  }

  /**
   * 刷新标签与收纳统计
   */
  async refreshStats() {
    try {
      const stats = await MessageBus.sendToBackground(ActionTypes.GET_HOME_STATS);
      if (stats && stats.success) {
        if (this.statsWindowTabs) this.statsWindowTabs.textContent = String(stats.currentWindowCount ?? 0);
        if (this.statsThresholdLabel) this.statsThresholdLabel.textContent = `/ ${stats.threshold ?? 15} 标签`;
        if (this.statsTotalGroups) this.statsTotalGroups.textContent = String(stats.totalGroups ?? 0);
        if (this.statsTotalItems) this.statsTotalItems.textContent = String(stats.totalItems ?? 0);
      }
    } catch {
      // 忽略统计读取异常
    }
  }

  /**
   * 刷新近期收纳卡片（使用摘要分页轻量读取，避免全库读取；不删除条目，直接打开）
   */
  async refreshRecentStash() {
    if (!this.recentStashList) return;
    try {
      const pageRes = await MessageBus.sendToBackground(ActionTypes.GET_STASH_GROUP_SUMMARIES_PAGE, {
        limit: 3,
        previewLimit: 3
      });
      const topGroups = Array.isArray(pageRes?.items) ? pageRes.items : [];
      if (topGroups.length === 0) {
        this.renderEmptyList(this.recentStashList, '目前没有已收纳的标签页');
        return;
      }

      this.recentStashList.innerHTML = '';

      topGroups.forEach((group) => {
        const box = document.createElement('div');
        box.className = 'bb-home-stash-group-box';

        const header = document.createElement('div');
        header.className = 'bb-home-stash-group-header';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'bb-home-stash-group-name';
        nameSpan.textContent = group.title || group.name || this.formatDate(group.createdAt);

        const timeSpan = document.createElement('span');
        const count = group.itemCount ?? (group.tabs || []).length;
        timeSpan.textContent = `${count} 个页面 · ${this.formatTimeAgo(group.createdAt)}`;

        header.appendChild(nameSpan);
        header.appendChild(timeSpan);
        box.appendChild(header);

        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'bb-home-stash-group-items';

        // 每个组显示前 3 个条目
        const previewTabs = (group.tabs || []).slice(0, 3);
        previewTabs.forEach((tab) => {
          const itemEl = this.createItemElement({
            url: tab.url,
            title: tab.title || tab.url,
            favIconUrl: tab.favIconUrl,
            extra: ''
          });
          itemsContainer.appendChild(itemEl);
        });

        box.appendChild(itemsContainer);
        this.recentStashList.appendChild(box);
      });
    } catch (err) {
      this.renderEmptyList(this.recentStashList, '加载近期收纳失败');
    }
  }

  /**
   * 刷新历史推荐区（真实权限检查、按需引导与推荐展示）
   */
  async refreshHistorySection() {
    if (!this.historyContainer) return;

    // 1. 真实权限检查（真实权限为准）
    let granted = false;
    try {
      if (typeof chrome !== 'undefined' && chrome.permissions?.contains) {
        granted = await chrome.permissions.contains({ permissions: ['history'] });
      }
    } catch {
      granted = false;
    }
    this.hasHistoryPermission = granted;

    if (this.btnRevokeHistory) {
      this.btnRevokeHistory.classList.toggle('bb-hidden', !granted);
    }

    // 2. 未授权：渲染权限申请引导卡片
    if (!granted) {
      this.historyContainer.innerHTML = '';
      const banner = document.createElement('div');
      banner.className = 'bb-home-permission-banner';

      const iconSvg = document.createElement('div');
      iconSvg.className = 'bb-home-permission-icon';
      iconSvg.innerHTML = `
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      `;

      const text = document.createElement('div');
      text.className = 'bb-home-permission-text';
      text.textContent = '开启可选历史记录权限后，主页可显示近 7 天最近访问与近 30 天高频访问推荐，并在搜索时匹配历史记录。';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bb-btn-sm bb-btn-primary';
      btn.textContent = '授权历史记录权限';
      btn.addEventListener('click', () => this.requestHistoryPermission());

      banner.appendChild(iconSvg);
      banner.appendChild(text);
      banner.appendChild(btn);
      this.historyContainer.appendChild(banner);
      return;
    }

    // 3. 已授权：读取推荐数据（最近近 7 天 / 常访近 30 天；标注访问次数 visitCount 非时长）
    try {
      const res = await MessageBus.sendToBackground(ActionTypes.GET_HISTORY_RECOMMENDATIONS, { limit: 5 });
      if (!res || !res.success || (!res.recent?.length && !res.topVisited?.length)) {
        this.renderEmptyList(this.historyContainer, '暂无可用历史记录');
        return;
      }

      this.historyContainer.innerHTML = '';

      // 优先展示常访页面 (Top Visited)
      if (Array.isArray(res.topVisited) && res.topVisited.length > 0) {
        const titleDiv = document.createElement('div');
        titleDiv.className = 'bb-home-dropdown-header';
        titleDiv.textContent = '常访推荐（近 30 天 · 按访问次数）';
        this.historyContainer.appendChild(titleDiv);

        res.topVisited.forEach((item) => {
          const itemEl = this.createItemElement({
            url: item.url,
            title: item.title,
            extra: `访问 ${item.visitCount || 1} 次`
          });
          this.historyContainer.appendChild(itemEl);
        });
      }

      // 展示最近访问页面 (Recent)
      if (Array.isArray(res.recent) && res.recent.length > 0) {
        const titleDiv = document.createElement('div');
        titleDiv.className = 'bb-home-dropdown-header';
        titleDiv.style.marginTop = '10px';
        titleDiv.textContent = '最近访问（近 7 天）';
        this.historyContainer.appendChild(titleDiv);

        res.recent.forEach((item) => {
          const itemEl = this.createItemElement({
            url: item.url,
            title: item.title,
            extra: this.formatTimeAgo(item.lastVisitTime)
          });
          this.historyContainer.appendChild(itemEl);
        });
      }
    } catch {
      this.renderEmptyList(this.historyContainer, '读取历史推荐失败');
    }
  }

  /**
   * 请求 Optional History 权限（必须由用户手势触发）
   */
  async requestHistoryPermission() {
    try {
      if (typeof chrome !== 'undefined' && chrome.permissions?.request) {
        const granted = await chrome.permissions.request({ permissions: ['history'] });
        if (granted) {
          this.hasHistoryPermission = true;
          await this.refreshHistorySection();
        }
      }
    } catch (err) {
      console.warn('[HomeView] 请求历史权限异常:', err);
    }
  }

  /**
   * 撤销 Optional History 权限
   */
  async revokeHistoryPermission() {
    try {
      this.hasHistoryPermission = false;
      if (this.historyGroup) {
        this.historyGroup.classList.add('bb-hidden');
        if (this.historyList) this.historyList.innerHTML = '';
      }
      if (typeof chrome !== 'undefined' && chrome.permissions?.remove) {
        await chrome.permissions.remove({ permissions: ['history'] });
      }
      await this.refreshHistorySection();
    } catch (err) {
      console.warn('[HomeView] 撤销历史权限异常:', err);
    }
  }

  /**
   * 调度统一搜索查询（250ms 防抖 + 请求序号保护）
   * @param {number} [delay=250]
   */
  scheduleSearch(delay = 250) {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const query = this.input ? this.input.value.trim() : '';
      this.executeSearch(query);
    }, delay);
  }

  /**
   * 执行聚合搜索（外部联想 + 本地收纳分页 + 历史搜索；错误隔离）
   * @param {string} query
   */
  async executeSearch(query) {
    if (!query) {
      this.closeDropdown();
      return;
    }

    this.lastSearchQuery = query;
    this.stashNextCursor = null;
    const seq = ++this.searchSeq;

    // 打开下拉层
    this.openDropdown();

    // 并行获取三大数据源，错误彼此隔离
    const tasks = [
      this.fetchSuggestions(query),
      this.fetchStashResults(query, 5, null),
      this.fetchHistoryResults(query)
    ];

    const [suggestRes, stashRes, historyRes] = await Promise.allSettled(tasks);

    // 检查响应序号，丢弃过期的过时请求
    if (seq !== this.searchSeq) return;

    this.currentOptions = [];
    this.activeOptionIndex = -1;

    // 1. 渲染外部联想建议
    this.renderSuggestionsSection(suggestRes.status === 'fulfilled' ? suggestRes.value : null);

    // 2. 渲染本地收纳检索
    this.renderStashSection(stashRes.status === 'fulfilled' ? stashRes.value : null);

    // 3. 渲染历史记录搜索
    this.renderHistorySection(historyRes.status === 'fulfilled' ? historyRes.value : null);

    // 若全部为空，显示空结果提示
    if (this.currentOptions.length === 0) {
      this.renderNoResults();
    }
  }

  /**
   * 获取外部联想建议
   */
  async fetchSuggestions(query) {
    const isExternalEnabled = this.config?.home?.enableExternalSuggest && this.config?.home?.externalSuggestAgreed;
    if (!isExternalEnabled) {
      // 提示同意外部联想
      if (this.consentCard && !this.config?.home?.externalSuggestAgreed) {
        this.consentCard.classList.remove('bb-hidden');
      }
      return null;
    }

    try {
      const res = await MessageBus.sendToBackground(ActionTypes.GET_SEARCH_SUGGESTIONS, {
        query,
        engine: this.config?.home?.suggestEngine || 'google'
      });
      return res?.success ? res.suggestions : null;
    } catch {
      return null;
    }
  }

  /**
   * 获取本地收纳分页匹配条目（含空页游标自进保护，避免首页空扫描导致收纳组静默隐藏）
   */
  async fetchStashResults(keyword, limit = 5, cursor = null) {
    try {
      let currentCursor = cursor;
      let rounds = 0;
      while (rounds < 5) {
        rounds++;
        const res = await MessageBus.sendToBackground(ActionTypes.SEARCH_STASH, {
          keyword,
          limit,
          cursor: currentCursor,
          paginated: true
        });
        const items = Array.isArray(res?.items)
          ? res.items
          : (Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []));
        if (items.length > 0 || !res?.hasMore || !res?.nextCursor) {
          return {
            items,
            nextCursor: res?.nextCursor || null,
            hasMore: Boolean(res?.hasMore && res?.nextCursor)
          };
        }
        currentCursor = res.nextCursor;
      }
      return { items: [], nextCursor: currentCursor, hasMore: true };
    } catch {
      return null;
    }
  }

  /**
   * 获取历史搜索结果
   */
  async fetchHistoryResults(query) {
    if (!this.hasHistoryPermission) return null;
    try {
      const res = await MessageBus.sendToBackground(ActionTypes.GET_BROWSER_HISTORY, {
        query,
        limit: 5
      });
      return res?.success ? res.items : null;
    } catch {
      return null;
    }
  }

  /**
   * 渲染外部联想列表
   */
  renderSuggestionsSection(suggestions) {
    if (!this.suggestGroup || !this.suggestList) return;
    this.suggestList.innerHTML = '';

    const isExternalEnabled = this.config?.home?.enableExternalSuggest && this.config?.home?.externalSuggestAgreed;
    if (!isExternalEnabled || !Array.isArray(suggestions) || suggestions.length === 0) {
      this.suggestGroup.classList.add('bb-hidden');
      return;
    }

    const engineLabel = (this.config?.home?.suggestEngine === 'bing') ? 'Bing' : 'Google';
    if (this.suggestHeaderTitle) {
      this.suggestHeaderTitle.textContent = `${engineLabel} 搜索联想`;
    }

    suggestions.forEach((text) => {
      const optId = `home-option-${this.currentOptions.length}`;
      const optionEl = document.createElement('div');
      optionEl.className = 'bb-home-option';
      optionEl.id = optId;
      optionEl.setAttribute('role', 'option');
      optionEl.setAttribute('aria-selected', 'false');

      const icon = document.createElement('div');
      icon.className = 'bb-home-option-icon';
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;

      const body = document.createElement('div');
      body.className = 'bb-home-option-body';

      const title = document.createElement('span');
      title.className = 'bb-home-option-title';
      title.textContent = text;

      body.appendChild(title);
      optionEl.appendChild(icon);
      optionEl.appendChild(body);

      const optionObj = {
        id: optId,
        element: optionEl,
        type: 'suggestion',
        text,
        action: (forceNewTab = false) => this.submitWebSearch(text, forceNewTab)
      };

      optionEl.addEventListener('click', (e) => optionObj.action(Boolean(e?.ctrlKey || e?.metaKey)));
      this.suggestList.appendChild(optionEl);
      this.currentOptions.push(optionObj);
    });

    this.suggestGroup.classList.remove('bb-hidden');
  }

  /**
   * 渲染本地收纳检索列表与分页按钮
   */
  renderStashSection(stashRes) {
    if (!this.stashGroup || !this.stashList) return;
    this.stashList.innerHTML = '';

    const items = Array.isArray(stashRes?.items)
      ? stashRes.items
      : (Array.isArray(stashRes?.data) ? stashRes.data : (Array.isArray(stashRes) ? stashRes : []));
    if (items.length === 0) {
      this.stashGroup.classList.add('bb-hidden');
      return;
    }

    this.stashNextCursor = stashRes?.nextCursor || null;
    const hasMore = Boolean(stashRes?.hasMore && this.stashNextCursor);

    items.forEach((item) => {
      const optId = `home-option-${this.currentOptions.length}`;
      const optionEl = document.createElement('div');
      optionEl.className = 'bb-home-option';
      optionEl.id = optId;
      optionEl.setAttribute('role', 'option');
      optionEl.setAttribute('aria-selected', 'false');

      const icon = document.createElement('div');
      icon.className = 'bb-home-option-icon';
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path></svg>`;

      const body = document.createElement('div');
      body.className = 'bb-home-option-body';

      const title = document.createElement('span');
      title.className = 'bb-home-option-title';
      title.textContent = item.title || item.url;

      const sub = document.createElement('span');
      sub.className = 'bb-home-option-sub';
      sub.textContent = item.url;

      body.appendChild(title);
      body.appendChild(sub);

      const badge = document.createElement('span');
      badge.className = 'bb-home-option-badge';
      badge.textContent = '查看组';
      badge.title = '在时间线中查看所属收纳组';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this.navigateToStash(item.groupId);
      });

      optionEl.appendChild(icon);
      optionEl.appendChild(body);
      optionEl.appendChild(badge);

      const optionObj = {
        id: optId,
        element: optionEl,
        type: 'stash',
        url: item.url,
        action: (forceNewTab = false) => this.openUrl(item.url, forceNewTab)
      };

      optionEl.addEventListener('click', (e) => optionObj.action(Boolean(e?.ctrlKey || e?.metaKey)));
      this.stashList.appendChild(optionEl);
      this.currentOptions.push(optionObj);
    });

    if (this.btnLoadMoreStash) {
      this.btnLoadMoreStash.classList.toggle('bb-hidden', !hasMore);
    }
    this.stashGroup.classList.remove('bb-hidden');
  }

  /**
   * 加载更多收纳检索结果
   */
  async loadMoreStashResults() {
    if (!this.lastSearchQuery || !this.stashNextCursor) return;
    try {
      const res = await this.fetchStashResults(this.lastSearchQuery, 5, this.stashNextCursor);
      const newItems = Array.isArray(res?.items)
        ? res.items
        : (Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []));
      if (!newItems || newItems.length === 0) return;

      this.stashNextCursor = res?.nextCursor || null;
      const hasMore = Boolean(res?.hasMore && this.stashNextCursor);

      newItems.forEach((item) => {
        const optId = `home-option-${this.currentOptions.length}`;
        const optionEl = document.createElement('div');
        optionEl.className = 'bb-home-option';
        optionEl.id = optId;
        optionEl.setAttribute('role', 'option');
        optionEl.setAttribute('aria-selected', 'false');

        const icon = document.createElement('div');
        icon.className = 'bb-home-option-icon';
        icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path></svg>`;

        const body = document.createElement('div');
        body.className = 'bb-home-option-body';

        const title = document.createElement('span');
        title.className = 'bb-home-option-title';
        title.textContent = item.title || item.url;

        const sub = document.createElement('span');
        sub.className = 'bb-home-option-sub';
        sub.textContent = item.url;

        body.appendChild(title);
        body.appendChild(sub);

        const badge = document.createElement('span');
        badge.className = 'bb-home-option-badge';
        badge.textContent = '查看组';
        badge.title = '在时间线中查看所属收纳组';
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          this.navigateToStash(item.groupId);
        });

        optionEl.appendChild(icon);
        optionEl.appendChild(body);
        optionEl.appendChild(badge);

        const optionObj = {
          id: optId,
          element: optionEl,
          type: 'stash',
          url: item.url,
          action: (forceNewTab = false) => this.openUrl(item.url, forceNewTab)
        };

        optionEl.addEventListener('click', (e) => optionObj.action(Boolean(e?.ctrlKey || e?.metaKey)));
        this.stashList.appendChild(optionEl);
        this.currentOptions.push(optionObj);
      });

      if (this.btnLoadMoreStash) {
        this.btnLoadMoreStash.classList.toggle('bb-hidden', !hasMore);
      }
    } catch {
      // 忽略分页加载异常
    }
  }

  /**
   * 渲染历史记录搜索列表
   */
  renderHistorySection(historyItems) {
    if (!this.historyGroup || !this.historyList) return;
    this.historyList.innerHTML = '';

    if (!this.hasHistoryPermission || !Array.isArray(historyItems) || historyItems.length === 0) {
      this.historyGroup.classList.add('bb-hidden');
      return;
    }

    historyItems.forEach((item) => {
      const optId = `home-option-${this.currentOptions.length}`;
      const optionEl = document.createElement('div');
      optionEl.className = 'bb-home-option';
      optionEl.id = optId;
      optionEl.setAttribute('role', 'option');
      optionEl.setAttribute('aria-selected', 'false');

      const icon = document.createElement('div');
      icon.className = 'bb-home-option-icon';
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;

      const body = document.createElement('div');
      body.className = 'bb-home-option-body';

      const title = document.createElement('span');
      title.className = 'bb-home-option-title';
      title.textContent = item.title || item.url;

      const sub = document.createElement('span');
      sub.className = 'bb-home-option-sub';
      sub.textContent = item.url;

      body.appendChild(title);
      body.appendChild(sub);

      const badge = document.createElement('span');
      badge.className = 'bb-home-option-badge';
      badge.textContent = `访问 ${item.visitCount || 1} 次`;

      optionEl.appendChild(icon);
      optionEl.appendChild(body);
      optionEl.appendChild(badge);

      const optionObj = {
        id: optId,
        element: optionEl,
        type: 'history',
        url: item.url,
        action: (forceNewTab = false) => this.openUrl(item.url, forceNewTab)
      };

      optionEl.addEventListener('click', (e) => optionObj.action(Boolean(e?.ctrlKey || e?.metaKey)));
      this.historyList.appendChild(optionEl);
      this.currentOptions.push(optionObj);
    });

    this.historyGroup.classList.remove('bb-hidden');
  }

  /**
   * 无匹配结果时渲染默认搜索引擎回车提示
   */
  renderNoResults() {
    if (!this.suggestGroup || !this.suggestList) return;
    this.suggestList.innerHTML = '';
    if (this.suggestHeaderTitle) {
      this.suggestHeaderTitle.textContent = '网页搜索';
    }

    const optId = `home-option-0`;
    const optionEl = document.createElement('div');
    optionEl.className = 'bb-home-option active';
    optionEl.id = optId;
    optionEl.setAttribute('role', 'option');
    optionEl.setAttribute('aria-selected', 'true');

    const icon = document.createElement('div');
    icon.className = 'bb-home-option-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;

    const body = document.createElement('div');
    body.className = 'bb-home-option-body';

    const title = document.createElement('span');
    title.className = 'bb-home-option-title';
    title.textContent = `在 ${ENGINE_NAMES[this.currentEngine] || '搜索引擎'} 中搜索 "${this.lastSearchQuery}"`;

    body.appendChild(title);
    optionEl.appendChild(icon);
    optionEl.appendChild(body);

    const optionObj = {
      id: optId,
      element: optionEl,
      type: 'search',
      action: (forceNewTab = false) => this.submitWebSearch(this.lastSearchQuery, forceNewTab)
    };

    optionEl.addEventListener('click', (e) => optionObj.action(Boolean(e?.ctrlKey || e?.metaKey)));
    this.suggestList.appendChild(optionEl);
    this.currentOptions.push(optionObj);
    this.activeOptionIndex = 0;
    this.suggestGroup.classList.remove('bb-hidden');
  }

  /**
   * 键盘 Combobox 高亮移动
   * @param {number} delta - 1 下移, -1 上移
   */
  moveActiveOption(delta) {
    if (this.currentOptions.length === 0) return;

    // 清除前一个高亮
    if (this.activeOptionIndex >= 0 && this.activeOptionIndex < this.currentOptions.length) {
      const prev = this.currentOptions[this.activeOptionIndex];
      prev.element?.classList.remove('active');
      prev.element?.setAttribute('aria-selected', 'false');
    }

    this.activeOptionIndex += delta;
    if (this.activeOptionIndex >= this.currentOptions.length) {
      this.activeOptionIndex = 0;
    } else if (this.activeOptionIndex < 0) {
      this.activeOptionIndex = this.currentOptions.length - 1;
    }

    const current = this.currentOptions[this.activeOptionIndex];
    if (current && current.element) {
      current.element.classList.add('active');
      current.element.setAttribute('aria-selected', 'true');
      current.element.scrollIntoView({ block: 'nearest' });
      this.input?.setAttribute('aria-activedescendant', current.id);
    }
  }

  /**
   * 回车键激活当前选中项，或直接提交网页搜索（支持修饰键新标签页打开）
   * @param {KeyboardEvent} [e]
   */
  handleEnterKey(e = null) {
    const forceNewTab = Boolean(e?.ctrlKey || e?.metaKey);
    if (this.activeOptionIndex >= 0 && this.activeOptionIndex < this.currentOptions.length) {
      const current = this.currentOptions[this.activeOptionIndex];
      current?.action?.(forceNewTab);
      return;
    }
    const query = this.input ? this.input.value.trim() : '';
    if (query) {
      this.submitWebSearch(query, forceNewTab);
    }
  }

  /**
   * 提交外部搜索引擎查询
   * @param {string} query
   * @param {boolean} [forceNewTab=false]
   */
  submitWebSearch(query, forceNewTab = false) {
    if (!query) return;
    const base = SEARCH_ENGINES[this.currentEngine] || SEARCH_ENGINES.google;
    const url = base + encodeURIComponent(query);
    this.openUrl(url, forceNewTab);
  }

  /**
   * 统一打开目标 URL（独立页在当前标签打开；管理中心在新标签打开；支持修饰键强制新标签）
   * @param {string} url
   * @param {boolean} [forceNewTab=false]
   */
  openUrl(url, forceNewTab = false) {
    if (!url) return;
    const targetIsNew = forceNewTab || this.openTarget === 'new';
    if (!targetIsNew) {
      if (typeof chrome !== 'undefined' && chrome.tabs?.update) {
        chrome.tabs.update({ url });
      } else {
        window.location.href = url;
      }
    } else {
      if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
        chrome.tabs.create({ url, active: true });
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    }
  }

  /**
   * 跳转到收纳时间线（可定位具体收纳组）
   * @param {string} [groupId=null]
   */
  navigateToStash(groupId = null) {
    if (typeof this.onNavigateToStash === 'function') {
      this.onNavigateToStash(groupId);
      return;
    }
    const hash = groupId ? `#stash?groupId=${encodeURIComponent(groupId)}` : '#stash';
    if (this.isStandalone) {
      const optionsUrl = chrome.runtime.getURL(`src/options/options.html${hash}`);
      if (chrome.tabs?.create) {
        chrome.tabs.create({ url: optionsUrl, active: true });
      } else {
        window.location.href = optionsUrl;
      }
    } else {
      window.location.hash = hash;
    }
  }

  /**
   * 设置当前搜索引擎
   * @param {string} engine
   * @param {boolean} [persist=true]
   */
  async setEngine(engine, persist = true) {
    if (!SEARCH_ENGINES[engine]) return;
    this.currentEngine = engine;
    this.engineBtns.forEach((btn) => {
      const isSelected = btn.dataset.engine === engine;
      btn.classList.toggle('active', isSelected);
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });

    if (persist) {
      try {
        const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
          home: {
            ...(this.config?.home || {}),
            searchEngine: engine
          }
        });
        if (!res) throw new Error('配置更新未成功');
        if (this.config) {
          this.config.home = { ...(this.config.home || {}), searchEngine: engine };
        }
        this.showPrefFeedback(`已设默认引擎为 ${ENGINE_NAMES[engine] || engine}`, 'success');
      } catch (err) {
        this.showPrefFeedback(`搜索引擎保存失败: ${err?.message || '更新异常'}`, 'error');
      }
    }
  }

  /**
   * 更新外部联想同意偏好
   * @param {boolean} agreed
   */
  async setExternalSuggestAgreed(agreed) {
    try {
      await StorageAdapter.updateUserConfig({
        home: {
          ...(this.config?.home || {}),
          enableExternalSuggest: Boolean(agreed),
          externalSuggestAgreed: Boolean(agreed),
          suggestEngine: this.currentEngine === 'bing' ? 'bing' : 'google'
        }
      });
      if (this.config) {
        this.config.home = {
          ...(this.config.home || {}),
          enableExternalSuggest: Boolean(agreed),
          externalSuggestAgreed: Boolean(agreed)
        };
      }
    } catch {
      // 忽略写入异常
    }
  }

  /**
   * 打开下拉层
   */
  openDropdown() {
    if (!this.dropdown) return;
    this.dropdown.classList.remove('bb-hidden');
    this.input?.setAttribute('aria-expanded', 'true');
  }

  /**
   * 关闭下拉层
   */
  closeDropdown() {
    if (!this.dropdown) return;
    this.dropdown.classList.add('bb-hidden');
    this.input?.setAttribute('aria-expanded', 'false');
    this.input?.removeAttribute('aria-activedescendant');
    this.activeOptionIndex = -1;
    this.currentOptions = [];
  }

  /**
   * 构造通用条目元素（防止 XSS，全程 textContent）
   */
  createItemElement({ url, title, favIconUrl, extra = '' }) {
    const a = document.createElement('a');
    a.className = 'bb-home-item';
    a.href = url || '#';

    a.addEventListener('click', (e) => {
      e.preventDefault();
      this.openUrl(url);
    });

    const mainDiv = document.createElement('div');
    mainDiv.className = 'bb-home-item-main';

    const iconImg = document.createElement('img');
    iconImg.className = 'bb-home-item-favicon';
    iconImg.alt = '';
    iconImg.src = favIconUrl || this.getDefaultFaviconUrl(url);
    iconImg.onerror = () => {
      iconImg.src = this.getDefaultFaviconUrl(url);
    };

    const infoDiv = document.createElement('div');
    infoDiv.className = 'bb-home-item-info';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'bb-home-item-title';
    titleSpan.textContent = title || url || '无标题页面';

    const metaSpan = document.createElement('span');
    metaSpan.className = 'bb-home-item-meta';
    metaSpan.textContent = this.formatHostname(url);

    infoDiv.appendChild(titleSpan);
    infoDiv.appendChild(metaSpan);
    mainDiv.appendChild(iconImg);
    mainDiv.appendChild(infoDiv);
    a.appendChild(mainDiv);

    if (extra) {
      const extraSpan = document.createElement('span');
      extraSpan.className = 'bb-home-item-extra';
      extraSpan.textContent = extra;
      a.appendChild(extraSpan);
    }

    return a;
  }

  /**
   * 渲染空提示列表
   */
  renderEmptyList(container, message) {
    if (!container) return;
    container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'bb-home-empty';

    const iconSvg = document.createElement('div');
    iconSvg.className = 'bb-home-empty-icon';
    iconSvg.innerHTML = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg>`;

    const textSpan = document.createElement('span');
    textSpan.textContent = message;

    div.appendChild(iconSvg);
    div.appendChild(textSpan);
    container.appendChild(div);
  }

  /**
   * 获取扩展内部图标路径
   */
  getIconUrl(size = 48) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(`src/icons/icon${size}.png`);
      }
    } catch {}
    return `../icons/icon${size}.png`;
  }

  /**
   * 获取默认网站根图标或安全缺省图
   */
  getDefaultFaviconUrl(rawUrl) {
    try {
      const origin = new URL(rawUrl).origin;
      return `${origin}/favicon.ico`;
    } catch {
      return this.getIconUrl(16);
    }
  }

  /**
   * 格式化主机名
   */
  formatHostname(rawUrl) {
    try {
      return new URL(rawUrl).hostname;
    } catch {
      return rawUrl || '';
    }
  }

  /**
   * 格式化时间戳为相对时间
   */
  formatTimeAgo(ts) {
    const delta = Math.floor((Date.now() - (Number(ts) || 0)) / 1000);
    if (delta < 60) return '刚刚';
    if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
    if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
    if (delta < 86400 * 30) return `${Math.floor(delta / 86400)} 天前`;
    return this.formatDate(ts);
  }

  /**
   * 格式化日期
   */
  formatDate(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  /**
   * 视图激活（进入前台时调用：聚焦搜索框、刷新最新统计与数据）
   */
  activate() {
    setTimeout(() => this.input?.focus(), 60);
    this.refreshAll().catch(() => {});
  }

  /**
   * 视图停用（切走离开时调用：关闭下拉框、取消未决定时器）
   */
  deactivate() {
    clearTimeout(this.debounceTimer);
    this.closeDropdown();
  }

  /**
   * 销毁组件：清理所有挂载的 DOM 监听器与定时器
   */
  destroy() {
    this.deactivate();
    clearTimeout(this.prefFeedbackTimer);
    for (const cleanup of this._cleanups) {
      try {
        cleanup();
      } catch {}
    }
    this._cleanups = [];
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}
