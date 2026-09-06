/**
 * @file home-view.js
 * @description 主页共享视图：独立数据源、可取消的搜索与设备本地隐私设置。
 * @encoding UTF-8
 */
import { ActionTypes } from '../constants/action-types.js';
import { MessageBus } from '../core/bus/message-bus.js';

const ENGINES = { google: ['Google', 'https://www.google.com/search?q='], bing: ['Bing', 'https://www.bing.com/search?q='], baidu: ['百度', 'https://www.baidu.com/s?wd='], duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q='] };
/** 允许导航/渲染为链接的协议白名单（openUrl 与 createItemElement 共用）。 */
const SAFE_PROTOCOLS = ['http:', 'https:', 'file:', 'chrome:', 'edge:', 'about:', 'chrome-extension:'];
const MODULES = { showWindowTabStats: ['浏览概览', 'homeStats'], showRecentStash: ['近期收纳', 'homeRecent'], showHistoryRecommendations: ['常访网站与继续浏览', 'homeHistory'] };
const LOOKS_LIKE_IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#].*)?$/;
const LOOKS_LIKE_HOST = /^(?:localhost|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?::\d+)?(?:[/?#].*)?$/i;
const FILEISH_NAME = /\.(html?|js|mjs|ts|json|md|txt|css|png|jpe?g|gif|svg|pdf|zip)$/i;
const SCHEME_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const SCHEMES_WITHOUT_SLASH = new Set(['about', 'chrome', 'edge', 'file', 'chrome-extension']);

/** 仅把真实协议（含 chrome/about 或带 ://）视为显式网址，避免把 localhost:端口误判成协议。 */
function hasExplicitProtocol(query) {
  const match = String(query).match(SCHEME_PREFIX);
  if (!match) return false;
  const scheme = match[1].toLowerCase();
  if (query.slice(match[1].length + 1, match[1].length + 3) === '//') return true;
  return SCHEMES_WITHOUT_SLASH.has(scheme);
}

/**
 * 将输入识别为打开网址或网页搜索。含空格、无点主机名与常见文件名视为搜索。
 * @param {string} raw
 * @returns {{ kind: 'empty' } | { kind: 'search', query: string } | { kind: 'url', url: string, display: string }}
 */
export function parseNavigationIntent(raw) {
  const query = String(raw ?? '').trim();
  if (!query) return { kind: 'empty' };
  if (/\s/.test(query)) return { kind: 'search', query };
  if (hasExplicitProtocol(query)) {
    try {
      const parsed = new URL(query);
      if (!SAFE_PROTOCOLS.includes(parsed.protocol)) return { kind: 'search', query };
      return { kind: 'url', url: parsed.href, display: query };
    } catch {
      return { kind: 'search', query };
    }
  }
  if (FILEISH_NAME.test(query) && !query.includes('/')) return { kind: 'search', query };
  if (LOOKS_LIKE_IPV4.test(query) || LOOKS_LIKE_HOST.test(query)) {
    try {
      const parsed = new URL(`https://${query}`);
      return { kind: 'url', url: parsed.href, display: query };
    } catch {
      return { kind: 'search', query };
    }
  }
  return { kind: 'search', query };
}

/**
 * 按偏移调整钉选顺序；越界或非法下标时返回原数组引用。
 * @param {Array} list
 * @param {number} index
 * @param {number} delta
 * @returns {Array}
 */
export function movePinnedSite(list, index, delta) {
  if (!Array.isArray(list)) return [];
  const from = Number(index), to = from + Number(delta);
  if (![from, to].every(Number.isInteger) || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice(), [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
const icon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };

/** 消息总线返回外层信封，业务结果可能另有 success 标志。 */
export async function requestHome(action, payload = {}) {
  const envelope = await MessageBus.sendToBackground(action, payload);
  if (!envelope || envelope.success !== true) throw new Error(envelope?.error || '后台连接失败，请重试');
  const data = envelope.data;
  if (data === false || data?.success === false) throw new Error(data?.error || '操作未成功，请重试');
  if (data === undefined || data === null) throw new Error('后台未返回有效数据');
  return data;
}

export class HomeView {
  constructor(options = {}) {
    this.container = options.container;
    this.openTarget = options.openTarget || 'current';
    this.isStandalone = Boolean(options.isStandalone);
    this.onNavigateToStash = options.onNavigateToStash;
    this.config = { home: {} };
    this.currentEngine = 'google';
    this.scope = 'all';
    this.searchSeq = 0;
    this.dataSeq = 0;
    this.configSeq = 0;
    this.currentOptions = [];
    this.activeOptionIndex = -1;
    this.active = false;
    this.destroyed = false;
    this._cleanups = [];
    this._liveCleanups = [];
    this.sources = {};
    this.ready = this.init();
  }

  async init() {
    if (!this.container) return;
    this.container.innerHTML = `<div class="bb-home-container">
      <header class="bb-home-header"><div class="bb-home-brand"><span class="bb-home-brand-mark" aria-hidden="true">${icon}</span><div><strong>BetterBrowse</strong><p id="homeDate"></p></div></div><nav aria-label="主页操作"><button data-command="destination">${this.isStandalone ? '管理中心' : '独立主页'} <span aria-hidden="true">↗</span></button><button data-command="customize">自定义</button></nav></header>
      <section class="bb-home-hero" aria-labelledby="homeTitle"><p class="bb-home-eyebrow" id="homeGreeting">你好</p><p class="bb-home-clock" id="homeClock">--:--</p><h1 id="homeTitle">从这里继续。</h1>
        <div class="bb-home-search-stage"><div class="bb-home-search-label"><label for="homeSearchInput">搜索或打开网址</label><div class="bb-home-engines" role="group" aria-label="网页搜索引擎">${Object.entries(ENGINES).map(([key, [name]]) => `<button type="button" data-engine="${key}" aria-pressed="false">${name}</button>`).join('')}</div></div>
          <form id="homeSearchForm" class="bb-home-search-box">${icon}<input id="homeSearchInput" type="text" placeholder="搜索网页、收纳，或直接输入网址" autocomplete="off" inputmode="search" enterkeyhint="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="homeResultList" aria-describedby="homeScopeHint"><button type="button" id="homeClear" data-command="clear" aria-label="清空搜索" hidden>清空</button><button class="bb-home-primary" type="submit">搜索</button></form>
          <div class="bb-home-scopes" role="group" aria-label="搜索范围"><span>搜索范围</span><button data-scope="all" aria-pressed="true">全部</button><button data-scope="stash" aria-pressed="false">收纳</button><button data-scope="history" aria-pressed="false">浏览记录</button><small id="homeScopeHint">回车搜索网页 · 方向键选择 · 按 <kbd>/</kbd> 或 <kbd>Ctrl</kbd>+<kbd>K</kbd> 快速聚焦</small></div>
          <div id="homeResults" class="bb-home-results" hidden><div id="homeResultList" role="listbox" aria-label="搜索结果"></div><div id="homeResultActions" class="bb-home-result-actions"></div></div>
        </div>
      </section>
      <div id="homeFeedback" class="bb-home-feedback" role="status" aria-live="polite"></div>
      <section id="homeFrequent" class="bb-home-frequent" aria-labelledby="homeFrequentTitle"><div class="bb-home-section-heading"><h2 id="homeFrequentTitle">常访网站</h2><span>钉选优先 · 其余按近 30 天访问次数</span></div><div id="homeShortcuts" class="bb-home-shortcuts"></div></section>
      <div class="bb-home-grid"><main class="bb-home-main"><section id="homeHistory"><div class="bb-home-section-heading"><h2>继续浏览</h2><span>最近访问 · 近 7 天</span></div><div id="homeRecentHistory" class="bb-home-history-list"></div></section><section id="homeRecent"><div class="bb-home-section-heading"><div><h2>近期收纳</h2><p>直接访问页面，保留原收纳条目</p></div><button data-command="stash">全部收纳 <span aria-hidden="true">→</span></button></div><div id="homeStashList" class="bb-home-stash-list"></div></section></main>
      <aside class="bb-home-aside"><section id="homeStats" class="bb-home-stats"><h2>浏览概览</h2><div id="homeStatsContent"></div></section><section class="bb-home-privacy"><h2>隐私，由你掌握</h2><p id="homePrivacyStatus"></p><p>收纳检索在本地完成。网站标识不请求远程图标。</p><button data-command="customize">管理隐私与展示 <span aria-hidden="true">→</span></button></section></aside></div>
      <dialog id="homeCustomize" class="bb-home-dialog" aria-labelledby="homeCustomizeTitle"><div class="bb-home-section-heading"><h2 id="homeCustomizeTitle">自定义主页</h2><button data-command="close-dialog" aria-label="关闭自定义">关闭</button></div><p>保留你需要的内容，让主页适合你的习惯。</p><fieldset><legend>展示模块</legend>${Object.entries(MODULES).map(([key, [label]]) => `<label><input type="checkbox" data-pref="${key}"> ${label}</label>`).join('')}</fieldset><fieldset><legend>钉选网站</legend><div id="homePinnedList"></div><form id="homePinnedForm"><input id="homePinnedTitle" type="text" placeholder="名称（可选）" maxlength="60" aria-label="钉选名称"><input id="homePinnedUrl" type="url" placeholder="https://example.com" aria-label="钉选网址" required><button type="submit">添加钉选</button></form><p>钉选固定展示在常访网站最前，不依赖浏览记录权限，仅保存在本设备配置中。</p></fieldset><fieldset><legend>搜索偏好</legend><label>默认网页引擎 <select data-setting="searchEngine">${this.engineOptions()}</select></label><label><input type="checkbox" id="homeSuggestConsent"> 我同意开启外部搜索联想</label><p>开启后，输入内容会发送给所选 Google 或 Bing 联想服务，不携带凭据、不记录搜索词审计。关闭即停止发送。</p><label>联想服务 <select data-setting="suggestEngine"><option value="google">Google</option><option value="bing">Bing</option></select></label><p>联想服务与网页搜索引擎独立；选择联想后使用默认网页引擎搜索。</p></fieldset><fieldset><legend>浏览记录权限</legend><p id="homePermissionStatus"></p><button data-command="permission" id="homePermissionButton">开启浏览记录</button><p>仅在此设备使用，可随时撤销。隐身模式不读取普通浏览记录。</p></fieldset><p id="homeDialogFeedback" role="status" aria-live="polite"></p></dialog>
    </div>`;
    this.input = this.$('#homeSearchInput');
    this.dropdown = this.$('#homeResults');
    this.updateClock();
    this.listen(this.container, 'click', e => this.onClick(e));
    this.listen(this.container, 'change', e => this.onChange(e));
    this.listen(this.input, 'input', () => { this.updateSubmitLabel(); this.scheduleSearch(); });
    this.listen(this.input, 'compositionstart', () => { this.isComposing = true; this.invalidateSearch(); });
    this.listen(this.input, 'compositionend', () => { this.isComposing = false; this.scheduleSearch(); });
    this.listen(this.input, 'keydown', e => this.onKeyDown(e));
    this.listen(this.$('#homeSearchForm'), 'submit', e => { e.preventDefault(); this.handleEnterKey(e); });
    this.listen(this.$('#homePinnedForm'), 'submit', e => { e.preventDefault(); this.addPinnedSite(); });
    this.listen(this.$('#homeCustomize'), 'close', () => { if (this.active) this.dialogOpener?.focus(); });
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.deactivate();
      else if (this.isStandalone || !this.container.closest('[hidden]') && this.container.getClientRects().length) this.activate();
    });
    if (this.isStandalone && !document.hidden) await this.activate();
  }

  $(selector) { return this.container.querySelector(selector); }
  engineOptions() { return Object.entries(ENGINES).map(([key, [name]]) => `<option value="${key}">${name}</option>`).join(''); }
  listen(target, event, handler, live = false) {
    target?.addEventListener(event, handler);
    (live ? this._liveCleanups : this._cleanups).push(() => target?.removeEventListener(event, handler));
  }
  feedback(message, error = false) {
    const live = this.$('#homeFeedback');
    const dialog = this.$('#homeDialogFeedback');
    this._feedbackToken = message;
    if (dialog) { dialog.textContent = message; dialog.classList.toggle('error', Boolean(error)); }
    if (!live) return;
    live.replaceChildren();
    live.classList.toggle('error', Boolean(error));
    if (!message) return;
    live.append(node('span', '', message));
    clearTimeout(this._feedbackTimer);
    this._feedbackTimer = setTimeout(() => {
      if (this.destroyed || this._feedbackToken !== message) return;
      live.replaceChildren();
    }, 5000);
  }
  onClick(e) {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.scope) { this.scope = button.dataset.scope; this.syncControls(); this.scheduleSearch(0); return; }
    if (button.dataset.engine) { this.setEngine(button.dataset.engine); return; }
    switch (button.dataset.command) {
      case 'customize': this.invalidateSearch(); this.dialogOpener = button; this.$('#homeCustomize').showModal(); break;
      case 'close-dialog': this.$('#homeCustomize').close(); break;
      case 'clear': this.input.value = ''; this.scheduleSearch(); this.input.focus(); break;
      case 'destination': this.isStandalone ? this.navigateToStash() : this.openUrl(chrome.runtime.getURL('src/newtab/newtab.html'), true); break;
      case 'stash': this.navigateToStash(); break;
      case 'stash-now': this.runManualStash(button, true); break;
      case 'stash-smart': this.runManualStash(button, false); break;
      case 'permission': this.hasHistoryPermission ? this.revokeHistoryPermission() : this.requestHistoryPermission(); break;
    }
  }
  onChange(e) {
    const el = e.target;
    if (el.dataset.pref) this.saveHome({ [el.dataset.pref]: el.checked });
    if (el.dataset.setting) this.saveHome({ [el.dataset.setting]: el.value });
    if (el.id === 'homeSuggestConsent') this.saveHome({ enableExternalSuggest: el.checked, externalSuggestAgreed: el.checked });
  }
  syncControls() {
    const home = this.config.home || {};
    this.currentEngine = ENGINES[home.searchEngine] ? home.searchEngine : 'google';
    this.container.querySelectorAll('[data-engine]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.engine === this.currentEngine)));
    this.container.querySelectorAll('[data-pref]').forEach(el => { el.checked = home[el.dataset.pref] !== false; });
    this.container.querySelectorAll('[data-setting]').forEach(el => { el.value = home[el.dataset.setting] || 'google'; });
    this.$('#homeSuggestConsent').checked = Boolean(home.enableExternalSuggest && home.externalSuggestAgreed);
    this.container.querySelectorAll('[data-scope]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.scope === this.scope)));
    this.$('#homeScopeHint').innerHTML = this.scope === 'all' ? '回车搜索或打开网址 · 方向键选择 · 按 <kbd>/</kbd> 或 <kbd>Ctrl</kbd>+<kbd>K</kbd> 快速聚焦' : '仅检索本地内容 · 不跳转外部搜索';
    this.renderPinnedList();
    this.applyModulePreferences();
    this.renderPrivacy();
    this.updateSubmitLabel();
  }
  /** 输入像网址时把提交按钮改为「打开」。 */
  updateSubmitLabel() {
    const btn = this.$('#homeSearchForm .bb-home-primary');
    const intent = parseNavigationIntent(this.input?.value);
    if (btn) btn.textContent = intent.kind === 'url' ? '打开' : '搜索';
    this.input?.setAttribute('enterkeyhint', intent.kind === 'url' ? 'go' : 'search');
  }
  applyModulePreferences() {
    for (const [key, [, id]] of Object.entries(MODULES)) this.$(`#${id}`).hidden = this.config.home?.[key] === false;
    this.$('#homeFrequent').hidden = this.config.home?.showHistoryRecommendations === false;
  }
  async loadConfig() {
    const seq = ++this.configSeq;
    try {
      const config = await requestHome(ActionTypes.GET_CONFIG);
      if (this.destroyed || seq !== this.configSeq) return;
      this.config = config;
      this.syncControls();
    } catch (err) { if (!this.destroyed && seq === this.configSeq) this.feedback(`加载设置失败：${err.message}`, true); }
  }
  async saveHome(patch) {
    this.invalidateSearch();
    try {
      await requestHome(ActionTypes.UPDATE_CONFIG, { home: patch });
      if (this.destroyed) return;
      this.config.home = { ...this.config.home, ...patch };
      this.feedback('设置已保存');
    } catch (err) { if (!this.destroyed) this.feedback(`保存失败，已恢复原设置：${err.message}`, true); }
    finally { if (!this.destroyed) { this.syncControls(); if (this.active) { this.refreshAll(); this.scheduleSearch(0); } } }
  }
  setEngine(engine) { if (ENGINES[engine]) return this.saveHome({ searchEngine: engine }); }

  /** 按当前时段返回问候语。 */
  greetingFor(hour) {
    if (hour < 5) return '夜深了';
    if (hour < 11) return '早上好';
    if (hour < 13) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }
  /** 更新页头日期时间与问候语；激活期间每 30 秒刷新。 */
  updateClock() {
    const now = new Date();
    const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now);
    const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    this.$('#homeDate').textContent = date;
    const clock = this.$('#homeClock');
    if (clock) {
      clock.textContent = time;
      clock.setAttribute('aria-label', `${date} ${time}`);
    }
    const greeting = this.$('#homeGreeting');
    if (greeting) greeting.textContent = this.greetingFor(now.getHours());
  }
  startClock() { this.updateClock(); this.stopClock(); this._clockTimer = setInterval(() => this.updateClock(), 30000); }
  stopClock() { if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; } }
  /** 全局快捷键：/ 或 Ctrl/Cmd+K 将焦点移入搜索框。 */
  handleGlobalKeydown(e) {
    if (e.defaultPrevented || e.isComposing) return;
    const isSlash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const isCtrlK = (e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    if (!isSlash && !isCtrlK) return;
    if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (this.$('#homeCustomize')?.open) return;
    if (!this.container.getClientRects().length) return;
    e.preventDefault();
    this.input?.focus(); this.input?.select();
  }

  /** 按域名哈希返回字母标识的色调类，保证同一站点颜色稳定。 */
  toneFor(url) {
    let host = '';
    try { host = new URL(url).hostname || url; } catch { host = String(url ?? ''); }
    let hash = 0;
    for (const ch of host) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return `bb-tone-${hash % 6}`;
  }

  /** 读取钉选网站列表（配置缺省时返回空数组）。 */
  getPinnedSites() {
    const list = this.config.home?.pinnedSites;
    return Array.isArray(list) ? list.filter(site => site && typeof site.url === 'string') : [];
  }

  /** 渲染常访网站磁贴：钉选固定在前，其余按近 30 天访问次数补足；topVisited 为 null 表示无历史数据。 */
  renderShortcuts(topVisited) {
    const shortcuts = this.$('#homeShortcuts');
    shortcuts.replaceChildren();
    const seen = new Set();
    for (const site of this.getPinnedSites()) {
      if (shortcuts.children.length >= 8) break;
      let host = '';
      try { host = new URL(site.url).hostname; } catch { continue; }
      const link = this.createItemElement({ url: site.url, title: site.title || host, extra: '已钉选' });
      link.classList.add('bb-home-shortcut');
      const remove = node('button', 'bb-home-pin-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除钉选 ${site.title || host}`);
      remove.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); this.removePinnedSiteByUrl(site.url); });
      link.append(remove);
      shortcuts.append(link); seen.add(host);
    }
    for (const item of Array.isArray(topVisited) ? topVisited : []) {
      if (shortcuts.children.length >= 8) break;
      const domain = this.formatHostname(item.url);
      if (seen.has(domain)) continue; seen.add(domain);
      const link = this.createItemElement({ ...item, extra: `访问 ${item.visitCount ?? 0} 次` });
      link.classList.add('bb-home-shortcut');
      shortcuts.append(link);
    }
    if (!shortcuts.children.length) {
      this.state(shortcuts, Array.isArray(topVisited) ? '近 30 天暂无常访网站，继续浏览后会在这里出现。' : '钉选常用网站固定展示在这里；开启浏览记录后还会自动整理常访网站。');
    }
  }

  /** 渲染自定义弹窗中的钉选管理列表。 */
  renderPinnedList() {
    const box = this.$('#homePinnedList');
    if (!box) return;
    box.replaceChildren();
    const pinned = this.getPinnedSites();
    if (!pinned.length) { box.append(node('p', 'bb-home-pinned-empty', '暂无钉选网站')); return; }
    pinned.forEach((site, index) => {
      const row = node('div', 'bb-home-pinned-row');
      const name = site.title || this.formatHostname(site.url);
      row.append(node('span', 'bb-home-pinned-name', name), node('span', 'bb-home-pinned-url', this.formatHostname(site.url)));
      const moves = node('div', 'bb-home-pinned-moves');
      const moveButton = (label, delta, disabled) => {
        const button = node('button', '', label);
        button.type = 'button'; button.disabled = disabled;
        button.setAttribute('aria-label', `将 ${name}${label}`);
        button.addEventListener('click', () => this.reorderPinnedSite(index, delta));
        return button;
      };
      moves.append(moveButton('上移', -1, index === 0), moveButton('下移', 1, index === pinned.length - 1));
      const remove = node('button', 'bb-home-pinned-remove', '移除');
      remove.type = 'button'; remove.addEventListener('click', () => this.removePinnedSite(index));
      row.append(moves, remove);
      box.append(row);
    });
  }

  /** 添加钉选网站：仅接受 http/https，去重并限制数量。 */
  async addPinnedSite() {
    const titleInput = this.$('#homePinnedTitle'), urlInput = this.$('#homePinnedUrl');
    let parsed;
    try { parsed = new URL(urlInput.value.trim()); } catch { this.feedback('网址格式无效，请检查后重试', true); return; }
    if (!['http:', 'https:'].includes(parsed.protocol)) { this.feedback('钉选仅支持 http/https 网址', true); return; }
    const pinned = this.getPinnedSites();
    if (pinned.length >= 12) { this.feedback('钉选网站最多 12 个', true); return; }
    if (pinned.some(site => site.url === parsed.href)) { this.feedback('该网址已在钉选列表中', true); return; }
    await this.saveHome({ pinnedSites: [...pinned, { title: (titleInput.value || '').trim() || parsed.hostname, url: parsed.href }] });
    titleInput.value = ''; urlInput.value = '';
  }

  /** 用变换函数更新钉选列表，保持无效操作不触发写入。 */
  updatePinnedSites(transform) {
    const current = this.getPinnedSites();
    const next = transform(current);
    return next === current ? undefined : this.saveHome({ pinnedSites: next });
  }

  /** 按下标移除钉选网站。 */
  removePinnedSite(index) {
    return this.updatePinnedSites(current => {
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return current;
      const next = current.slice(); next.splice(index, 1); return next;
    });
  }

  /** 按 URL 移除钉选网站（磁贴上的快捷移除入口）。 */
  removePinnedSiteByUrl(url) {
    return this.removePinnedSite(this.getPinnedSites().findIndex(site => site.url === url));
  }

  /** 调整钉选顺序并写回设备本地配置。 */
  reorderPinnedSite(index, delta) {
    return this.updatePinnedSites(current => movePinnedSite(current, index, delta));
  }


  async activate() {
    if (this.destroyed || document.hidden) return;
    if (!this.active) {
      this.active = true;
      this.listen(document, 'click', e => { if (!this.$('.bb-home-search-stage').contains(e.target)) this.invalidateSearch(); }, true);
      const configChanged = message => {
        if (message?.action !== ActionTypes.NOTIFY_CONFIG_UPDATED) return;
        this.invalidateSearch(); this.clearHistory(); ++this.dataSeq;
        this.loadConfig().then(() => { if (this.active) { this.refreshAll(); this.scheduleSearch(0); } });
      };
      const permissionChanged = change => {
        if (!change.permissions?.includes('history')) return;
        this.invalidateSearch(); this.clearHistory(); ++this.dataSeq;
        this.refreshAll();
      };
      for (const [event, fn] of [[chrome.runtime?.onMessage, configChanged], [chrome.permissions?.onRemoved, permissionChanged], [chrome.permissions?.onAdded, permissionChanged]]) {
        event?.addListener(fn); this._liveCleanups.push(() => event?.removeListener(fn));
      }
      this.listen(document, 'keydown', e => this.handleGlobalKeydown(e), true);
    }
    this.startClock();
    await this.loadConfig();
    if (this.active) await this.refreshAll();
  }
  deactivate() {
    this.active = false; this.stopClock(); ++this.dataSeq; ++this.configSeq; this.invalidateSearch(); this.clearHistory();
    this._pendingRestore = null; clearTimeout(this._pendingRestoreTimer); clearTimeout(this._feedbackTimer);
    this.$('#homeCustomize')?.close();
    for (const cleanup of this._liveCleanups.splice(0)) cleanup();
  }
  destroy() { this.deactivate(); this.destroyed = true; for (const cleanup of this._cleanups.splice(0)) cleanup(); this.container.replaceChildren(); }

  async refreshAll() {
    if (!this.active || this.destroyed) return;
    const seq = ++this.dataSeq;
    this.applyModulePreferences();
    await Promise.allSettled([this.refreshStats(seq), this.refreshRecentStash(seq), this.refreshHistorySection(seq)]);
  }
  validData(seq) { return this.active && !this.destroyed && seq === this.dataSeq; }
  state(container, message, retry, label = '重试') {
    container.replaceChildren(node('p', 'bb-home-empty', message));
    if (retry) { const b = node('button', 'bb-home-text-button', label); b.type = 'button'; b.addEventListener('click', retry); container.append(b); }
  }
  /** 以微光骨架占位替代"正在读取…"纯文本，降低感知等待。 */
  renderSkeleton(container, lines = 3) {
    if (!container) return;
    container.replaceChildren();
    const box = node('div', 'bb-home-skeleton');
    box.setAttribute('aria-hidden', 'true');
    const widths = ['', 'bb-w-75', 'bb-w-55'];
    for (let i = 0; i < lines; i += 1) box.append(node('div', `bb-home-skeleton-line ${widths[i % widths.length]}`));
    container.append(box);
    const status = node('span', 'bb-home-sr', '正在加载…');
    status.setAttribute('role', 'status');
    container.append(status);
  }
  async refreshStats(seq = this.dataSeq) {
    if (this.config.home?.showWindowTabStats === false) return;
    const el = this.$('#homeStatsContent');
    // 仅空容器显示骨架；刷新时保留旧内容等待新数据，避免收纳/配置变更后整卡闪烁
    if (!el.children.length) this.renderSkeleton(el, 4);
    try {
      const stats = await requestHome(ActionTypes.GET_HOME_STATS);
      if (!this.validData(seq)) return;
      const over = stats.currentWindowCount >= stats.threshold;
      el.innerHTML = `<div class="bb-home-window-count"><strong></strong><span>当前窗口标签</span></div><progress aria-label="当前窗口标签与收纳阈值"></progress><p class="bb-home-threshold"></p><div class="bb-home-totals"><div><strong></strong><span>收纳组</span></div><div><strong></strong><span>已收纳页面</span></div></div><p class="bb-home-week"></p><div class="bb-home-stash-actions">${over ? '<button type="button" data-command="stash-smart" class="bb-home-stash-now">智能收纳闲置标签</button>' : ''}<button type="button" data-command="stash-now" class="${over ? 'bb-home-stash-all' : 'bb-home-stash-now'}">收纳本窗口全部标签</button></div>`;
      el.querySelector('.bb-home-window-count strong').textContent = String(stats.currentWindowCount);
      const progress = el.querySelector('progress'); progress.max = Math.max(1, stats.threshold); progress.value = stats.currentWindowCount;
      el.querySelector('.bb-home-threshold').textContent = `收纳阈值 ${stats.threshold} 个 · ${over ? '已达到阈值' : `还可浏览 ${stats.threshold - stats.currentWindowCount} 个`}`;
      this.$('#homeStats').dataset.over = String(over);
      const totals = el.querySelectorAll('.bb-home-totals strong'); totals[0].textContent = String(stats.totalGroups); totals[1].textContent = String(stats.totalItems);
      el.querySelector('.bb-home-week').textContent = `本周收纳 ${stats.weekGroupCount ?? 0} 组 · ${stats.weekItemCount ?? 0} 条`;
    } catch (err) { if (this.validData(seq)) this.state(el, `概览加载失败：${err.message}`, () => this.refreshStats()); }
  }
  /** 主页快捷收纳：默认全量；达到阈值时提供智能收纳（forceAll: false）。 */
  async runManualStash(button, forceAll = true) {
    if (!button || button.disabled) return;
    const buttons = [...this.container.querySelectorAll('[data-command="stash-now"], [data-command="stash-smart"]')];
    const originals = new Map(buttons.map(el => [el, el.textContent]));
    for (const el of buttons) { el.disabled = true; }
    button.textContent = '正在收纳…';
    try {
      const res = await requestHome(ActionTypes.EXECUTE_STASH, { forceAll });
      const count = Number(res?.stashedCount) || 0;
      const groupId = res?.groupId || null;
      if (!count) {
        this.feedback(res?.note || (forceAll ? '当前窗口没有可收纳的网页' : '当前没有可收纳的闲置标签'));
      } else {
        this.feedback(`已收纳 ${count} 个标签页至时间线`);
        if (groupId) {
          const live = this.$('#homeFeedback');
          const undo = node('button', 'bb-home-feedback-action', '撤销');
          undo.type = 'button';
          undo.addEventListener('click', () => { live.replaceChildren(); this.undoRecentStash(groupId); });
          live?.append(undo);
          clearTimeout(this._feedbackTimer);
          this._feedbackTimer = setTimeout(() => { if (!this.destroyed && live?.contains(undo)) live.replaceChildren(); }, 10000);
        }
      }
    } catch (err) { this.feedback(`收纳失败：${err.message}`, true); }
    finally {
      if (this.destroyed) return;
      for (const el of buttons) { el.disabled = false; el.textContent = originals.get(el) || el.textContent; }
      if (this.active) { this.refreshStats(); this.refreshRecentStash(); }
    }
  }
  /** 撤销刚刚创建的收纳组：恢复标签并删除该组。 */
  async undoRecentStash(groupId) {
    if (!groupId) return;
    try {
      await requestHome(ActionTypes.RESTORE_STASH_GROUP, { groupId, removeAfterRestore: true });
      this.feedback('已撤销本次收纳，标签页已恢复');
    } catch (err) { this.feedback(`撤销失败：${err.message}`, true); }
    if (this.active) { this.refreshStats(); this.refreshRecentStash(); }
  }
  async refreshRecentStash(seq = this.dataSeq) {
    if (this.config.home?.showRecentStash === false) return;
    const el = this.$('#homeStashList');
    if (!el.children.length) this.renderSkeleton(el, 3);
    try {
      const result = await requestHome(ActionTypes.GET_STASH_GROUP_SUMMARIES_PAGE, { limit: 3, previewLimit: 3 });
      if (!this.validData(seq)) return;
      if (!result.items?.length) { this.state(el, '还没有收纳组。收纳闲置标签后，可以从这里继续。', () => this.navigateToStash(), '前往收纳箱'); return; }
      el.replaceChildren();
      for (const group of result.items) {
        const box = node('article', 'bb-home-stash-group');
        const heading = node('div', 'bb-home-group-heading');
        const title = node('div', ''); title.append(node('h3', '', group.title || group.name || '未命名收纳组'), node('p', '', `${group.itemCount ?? group.tabs?.length ?? 0} 个页面 · ${this.formatTimeAgo(group.createdAt)}`));
        const actions = node('div', 'bb-home-group-actions');
        const viewButton = node('button', '', '查看组'); viewButton.addEventListener('click', () => this.navigateToStash(group.groupId || group.id));
        const restore = node('button', 'bb-home-group-restore', '恢复');
        restore.title = '恢复整组标签页；若设置为恢复后移除条目，需再次确认';
        restore.addEventListener('click', () => this.restoreStashGroup(group, restore));
        actions.append(viewButton, restore);
        heading.append(title, actions); box.append(heading);
        for (const tab of (group.tabs || []).slice(0, 3)) box.append(this.createItemElement(tab));
        el.append(box);
      }
    } catch (err) { if (this.validData(seq)) this.state(el, `近期收纳加载失败：${err.message}`, () => this.refreshRecentStash()); }
  }
  /** 主页快捷恢复整组标签页（恢复后条目处置遵循收纳箱 restoreBehavior 设置）。 */
  async restoreStashGroup(group, button) {
    const groupId = group?.groupId || group?.id;
    if (!groupId || !button || button.disabled) return;
    const removes = this.config.stashSettings?.restoreBehavior === 'remove';
    if (removes && this._pendingRestore !== groupId) {
      this._pendingRestore = groupId;
      button.dataset.originalLabel = button.textContent;
      button.textContent = '确认恢复';
      button.classList.add('bb-home-confirming');
      clearTimeout(this._pendingRestoreTimer);
      this._pendingRestoreTimer = setTimeout(() => {
        if (this._pendingRestore !== groupId || this.destroyed) return;
        this._pendingRestore = null;
        button.textContent = button.dataset.originalLabel || '恢复';
        button.classList.remove('bb-home-confirming');
      }, 4000);
      return;
    }
    this._pendingRestore = null;
    clearTimeout(this._pendingRestoreTimer);
    button.disabled = true;
    const original = button.dataset.originalLabel || button.textContent;
    button.classList.remove('bb-home-confirming');
    button.textContent = '恢复中…';
    try {
      await requestHome(ActionTypes.RESTORE_STASH_GROUP, { groupId });
      this.feedback(`已恢复「${group.title || group.name || '未命名收纳组'}」的标签页`);
    } catch (err) {
      this.feedback(`恢复失败：${err.message}`, true);
      button.disabled = false; button.textContent = original;
      return;
    }
    if (this.active) { this.refreshStats(); this.refreshRecentStash(); }
  }
  async checkHistoryPermission() {
    if (chrome.extension?.inIncognitoContext) return false;
    return Boolean(await chrome.permissions?.contains({ permissions: ['history'] }));
  }
  clearHistory() {
    this.hasHistoryPermission = false;
    for (const selector of ['#homeShortcuts', '#homeRecentHistory']) this.$(selector)?.replaceChildren();
    this.renderPrivacy();
  }
  renderPrivacy() {
    const incognito = Boolean(globalThis.chrome?.extension?.inIncognitoContext);
    const history = incognito ? '隐身模式：不读取浏览记录' : this.hasHistoryPermission ? '浏览记录已授权，仅在此设备使用' : '浏览记录未授权';
    const suggest = this.config.home?.enableExternalSuggest && this.config.home?.externalSuggestAgreed ? `外部联想已开启 · ${this.config.home.suggestEngine === 'bing' ? 'Bing' : 'Google'}` : '外部联想已关闭';
    this.$('#homePrivacyStatus').textContent = `${history}。${suggest}。`;
    this.$('#homePermissionStatus').textContent = history;
    const button = this.$('#homePermissionButton'); button.textContent = this.hasHistoryPermission ? '撤销浏览记录权限' : '开启浏览记录'; button.disabled = incognito;
  }
  async refreshHistorySection(seq = this.dataSeq) {
    const recent = this.$('#homeRecentHistory'), shortcuts = this.$('#homeShortcuts');
    try {
      const granted = await this.checkHistoryPermission();
      if (!this.validData(seq)) return;
      this.hasHistoryPermission = granted; this.renderPrivacy();
      if (!granted) { this.renderUngrantedHistory(recent); return; }
      if (this.config.home?.showHistoryRecommendations === false) return;
      if (!recent.children.length) this.renderSkeleton(recent, 3);
      if (!shortcuts.children.length) this.renderSkeleton(shortcuts, 4);
      const result = await requestHome(ActionTypes.GET_HISTORY_RECOMMENDATIONS, { limit: 8 });
      if (!this.validData(seq)) return;
      if (result.granted === false) { this.clearHistory(); this.renderUngrantedHistory(recent); return; }
      recent.replaceChildren();
      for (const item of (result.recent || []).slice(0, 4)) recent.append(this.createItemElement({ ...item, extra: this.formatTimeAgo(item.lastVisitTime) }));
      this.renderShortcuts(result.topVisited || []);
      if (!recent.children.length) this.state(recent, '近 7 天没有可展示的浏览记录。');
    } catch (err) { if (this.validData(seq)) { this.state(recent, `浏览记录加载失败：${err.message}`, () => this.refreshHistorySection()); this.state(shortcuts, '常访网站暂不可用。', () => this.refreshHistorySection()); } }
  }
  /** 无浏览记录权限时的引导渲染（本地预检与后台响应复查共用一条路径）。 */
  renderUngrantedHistory(recent) {
    const incognito = chrome.extension?.inIncognitoContext;
    this.state(recent, incognito ? '隐身模式不读取普通浏览记录。' : '开启后可找回近 7 天访问的页面，也能在搜索中检索浏览记录。', incognito ? null : () => this.requestHistoryPermission(), '开启浏览记录');
    this.renderShortcuts(null);
  }
  async requestHistoryPermission() {
    try { const granted = await chrome.permissions.request({ permissions: ['history'] }); this.feedback(granted ? '浏览记录权限已开启' : '未开启浏览记录权限'); this.invalidateSearch(); await this.refreshAll(); }
    catch (err) { this.feedback(`开启失败：${err.message}`, true); }
  }
  async revokeHistoryPermission() {
    this.invalidateSearch(); ++this.dataSeq; this.clearHistory();
    try { const removed = await chrome.permissions.remove({ permissions: ['history'] }); if (!removed) throw new Error('浏览器未撤销权限'); this.feedback('浏览记录权限已撤销'); }
    catch (err) { this.feedback(`撤销失败：${err.message}`, true); }
    await this.refreshAll();
  }

  invalidateSearch() {
    ++this.searchSeq; clearTimeout(this.debounceTimer); this.stashNextCursor = null; this.loadingMore = false;
    this.sources = {}; this.currentOptions = []; this.activeOptionIndex = -1;
    if (this.dropdown) { this.dropdown.hidden = true; this.$('#homeResultList').replaceChildren(); this.$('#homeResultActions').replaceChildren(); }
    this.input?.setAttribute('aria-expanded', 'false'); this.input?.removeAttribute('aria-activedescendant');
  }
  scheduleSearch(delay = 180) {
    this.invalidateSearch(); this.$('#homeClear').hidden = !this.input.value;
    if (!this.active || this.isComposing || !this.input.value.trim()) return;
    this.debounceTimer = setTimeout(() => this.executeSearch(this.input.value.trim()), delay);
  }
  async executeSearch(query) {
    this.invalidateSearch();
    if (!query || !this.active || this.isComposing) return;
    const seq = this.searchSeq; this.lastSearchQuery = query;
    const wanted = this.scope === 'all' ? ['suggest', 'stash', 'history'] : [this.scope];
    for (const source of wanted) this.sources[source] = { state: 'loading', items: [] };
    this.renderSearch();
    await Promise.allSettled(wanted.map(async source => {
      try {
        let result;
        if (source === 'stash') result = await this.fetchStashResults(query);
        if (source === 'suggest') {
          if (!this.config.home?.enableExternalSuggest || !this.config.home?.externalSuggestAgreed) result = { state: 'disabled', items: [] };
          else { const data = await requestHome(ActionTypes.GET_SEARCH_SUGGESTIONS, { query, engine: this.config.home.suggestEngine || 'google' }); result = { items: [...new Set(data.suggestions || [])].map(text => ({ title: text, text })) }; }
        }
        if (source === 'history') {
          if (!await this.checkHistoryPermission()) result = { state: 'permission', items: [] };
          else { const data = await requestHome(ActionTypes.GET_BROWSER_HISTORY, { query, limit: 8 }); result = data.granted === false ? { state: 'permission', items: [] } : { items: data.items || [] }; }
        }
        if (!this.validSearch(seq)) return;
        this.sources[source] = { state: 'ready', ...result };
        if (source === 'stash') this.stashNextCursor = result.hasMore ? result.nextCursor : null;
      } catch (err) { if (!this.validSearch(seq)) return; this.sources[source] = { state: 'error', items: [], error: err.message }; }
      this.renderSearch();
    }));
  }
  validSearch(seq) { return this.active && !this.destroyed && seq === this.searchSeq; }
  async fetchStashResults(keyword, limit = 5, cursor = null) {
    let current = cursor;
    for (let round = 0; round < 5; round++) {
      const result = await requestHome(ActionTypes.SEARCH_STASH, { keyword, limit, cursor: current, paginated: true });
      const items = result.items || result.data || [];
      if (items.length || !result.hasMore || !result.nextCursor) return { items, hasMore: Boolean(result.hasMore && result.nextCursor), nextCursor: result.nextCursor || null };
      current = result.nextCursor;
    }
    return { items: [], hasMore: true, nextCursor: current };
  }
  async loadMoreStashResults() {
    if (this.loadingMore || !this.stashNextCursor) return;
    const seq = this.searchSeq, cursor = this.stashNextCursor;
    this.loadingMore = true; this.renderSearch();
    try {
      const result = await this.fetchStashResults(this.lastSearchQuery, 5, cursor);
      if (!this.validSearch(seq)) return;
      const items = [...(this.sources.stash?.items || []), ...result.items];
      this.sources.stash = { state: 'ready', ...result, items };
      this.stashNextCursor = result.hasMore ? result.nextCursor : null;
    } catch (err) { if (this.validSearch(seq)) this.sources.stash.error = `加载更多失败：${err.message}`; }
    finally { if (this.validSearch(seq)) { this.loadingMore = false; this.renderSearch(); } }
  }
  renderSearch() {
    const list = this.$('#homeResultList'), actions = this.$('#homeResultActions');
    list.replaceChildren(); actions.replaceChildren(); this.currentOptions = []; this.activeOptionIndex = -1; this.input.removeAttribute('aria-activedescendant');
    this.dropdown.hidden = false; this.input.setAttribute('aria-expanded', 'true');
    const addOption = (parent, title, meta, action) => {
      const el = node('div', 'bb-home-option'); el.id = `home-option-${this.currentOptions.length}`; el.setAttribute('role', 'option'); el.setAttribute('aria-selected', 'false');
      el.append(node('span', 'bb-home-option-title', title), node('span', 'bb-home-option-meta', meta));
      el.addEventListener('click', e => action(Boolean(e.ctrlKey || e.metaKey || e.shiftKey)));
      parent.append(el); this.currentOptions.push({ id: el.id, element: el, action }); return el;
    };
    if (this.scope === 'all') {
      const intent = parseNavigationIntent(this.lastSearchQuery);
      if (intent.kind === 'url') {
        addOption(list, `打开 ${intent.display}`, '网址', force => this.openUrl(intent.url, force)).classList.add('bb-home-option-primary');
        addOption(list, `在 ${ENGINES[this.currentEngine][0]} 搜索“${this.lastSearchQuery}”`, '网页搜索', force => this.submitWebSearch(this.lastSearchQuery, force));
      } else {
        addOption(list, `在 ${ENGINES[this.currentEngine][0]} 搜索“${this.lastSearchQuery}”`, '网页搜索', force => this.submitWebSearch(this.lastSearchQuery, force)).classList.add('bb-home-option-primary');
      }
    }
    const labels = { suggest: `${this.config.home?.suggestEngine === 'bing' ? 'Bing' : 'Google'} 联想`, stash: '已收纳页面', history: '浏览记录' };
    for (const [source, data] of Object.entries(this.sources)) {
      const group = node('div', 'bb-home-result-group'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', labels[source]);
      const countSuffix = data.state === 'ready' && data.items?.length ? ` · ${data.items.length} 条` : '';
      group.append(node('div', 'bb-home-result-heading', labels[source] + countSuffix)); list.append(group);
      const message = { loading: '正在搜索…', error: `加载失败：${data.error}`, disabled: '外部联想已关闭，可在自定义中主动开启。', permission: '未授权浏览记录，或当前处于隐身模式。' }[data.state];
      if (message) group.append(node('p', 'bb-home-result-state', message));
      const seen = new Set();
      for (const item of data.items || []) {
        const key = `${item.url || item.text}|${item.groupId || ''}`; if (seen.has(key)) continue; seen.add(key);
        addOption(group, item.title || item.url, item.url ? `${this.formatHostname(item.url)}${source === 'stash' ? ` · ${item.groupName || item.groupTitle || '收纳组'}` : ` · ${this.formatTimeAgo(item.lastVisitTime)}`}` : `使用 ${ENGINES[this.currentEngine][0]} 搜索`, force => item.text ? this.submitWebSearch(item.text, force) : this.openUrl(item.url, force));
        if (source === 'stash' && item.groupId) addOption(group, `查看组：${item.groupName || item.groupTitle || item.title || '所属收纳组'}`, '打开收纳时间线，不移除页面', () => this.navigateToStash(item.groupId));
      }
      if (data.state === 'ready' && !data.items?.length) group.append(node('p', 'bb-home-result-state', source === 'stash' && this.stashNextCursor ? '本批未匹配到页面，可继续检索后续收纳。' : '没有匹配结果。'));
      if (data.state === 'error') { const retry = node('button', '', `重试${labels[source]}`); retry.addEventListener('click', () => this.executeSearch(this.input.value.trim())); actions.append(retry); }
      if (source === 'stash' && data.error && data.state !== 'error') actions.append(node('p', 'error', data.error));
      if (data.state === 'permission' && !chrome.extension?.inIncognitoContext) { const grant = node('button', '', '开启浏览记录'); grant.addEventListener('click', () => this.requestHistoryPermission()); actions.append(grant); }
    }
    if (this.stashNextCursor) { const more = node('button', '', this.loadingMore ? '正在继续检索…' : '继续检索收纳'); more.disabled = this.loadingMore; more.addEventListener('click', () => this.loadMoreStashResults()); actions.append(more); }
  }
  onKeyDown(e) {
    if (this.isComposing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { if (this.dropdown.hidden) { this.input.blur(); } else { e.preventDefault(); this.invalidateSearch(); } }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.moveActiveOption(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter') { e.preventDefault(); this.handleEnterKey(e); }
  }
  moveActiveOption(delta) {
    if (!this.currentOptions.length) { this.scheduleSearch(0); return; }
    this.activeOptionIndex = (this.activeOptionIndex + delta + this.currentOptions.length) % this.currentOptions.length;
    this.currentOptions.forEach((option, i) => { option.element.setAttribute('aria-selected', String(i === this.activeOptionIndex)); });
    const option = this.currentOptions[this.activeOptionIndex]; this.input.setAttribute('aria-activedescendant', option.id); option.element.scrollIntoView({ block: 'nearest' });
  }
  handleEnterKey(e = {}) {
    if (this.isComposing || e.isComposing) return;
    const force = Boolean(e.ctrlKey || e.metaKey || e.shiftKey);
    const option = this.currentOptions[this.activeOptionIndex];
    if (option) option.action(force);
    else {
      const query = this.input.value.trim();
      const intent = parseNavigationIntent(query);
      if (this.scope === 'all' && intent.kind === 'url') this.openUrl(intent.url, force);
      else if (this.scope === 'all') this.submitWebSearch(query, force);
      else this.executeSearch(query);
    }
  }
  submitWebSearch(query, force = false) { if (query && this.scope === 'all') this.openUrl(ENGINES[this.currentEngine][1] + encodeURIComponent(query), force); }
  openUrl(url, force = false) {
    try { if (!SAFE_PROTOCOLS.includes(new URL(url).protocol)) return; } catch { return; }
    const request = force || this.openTarget === 'new' ? chrome.tabs.create({ url, active: true }) : chrome.tabs.update({ url });
    Promise.resolve(request).catch(err => this.feedback(`打开页面失败：${err.message}`, true));
  }
  navigateToStash(groupId = null) {
    if (this.onNavigateToStash) { this.onNavigateToStash(groupId); return; }
    const hash = groupId ? `#stash?groupId=${encodeURIComponent(groupId)}` : '#stash';
    this.openUrl(chrome.runtime.getURL(`src/options/options.html${hash}`), true);
  }
  createItemElement({ url, title, extra = '' }) {
    const link = node('a', 'bb-home-item');
    try { if (!SAFE_PROTOCOLS.includes(new URL(url).protocol)) throw new Error(); link.href = url; } catch { link.href = '#'; }
    link.addEventListener('click', e => { e.preventDefault(); this.openUrl(url, Boolean(e.ctrlKey || e.metaKey || e.shiftKey)); });
    const domain = this.formatHostname(url), mark = node('span', `bb-home-site-mark ${this.toneFor(url)}`, (domain.replace(/^www\./, '')[0] || '·').toUpperCase()); mark.setAttribute('aria-hidden', 'true');
    const info = node('span', 'bb-home-item-info'); info.append(node('span', 'bb-home-item-title', title || domain || '无标题页面'), node('span', 'bb-home-item-meta', domain));
    link.append(mark, info); if (extra) link.append(node('span', 'bb-home-item-extra', extra)); return link;
  }
  formatHostname(url) { try { return new URL(url).hostname || new URL(url).protocol; } catch { return '未知网站'; } }
  formatTimeAgo(ts) {
    if (!Number(ts)) return '时间未知';
    const seconds = Math.max(0, (Date.now() - Number(ts)) / 1000);
    if (seconds < 60) return '刚刚'; if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`; if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`; if (seconds < 2592000) return `${Math.floor(seconds / 86400)} 天前`;
    return new Date(Number(ts)).toLocaleDateString('zh-CN');
  }
}
