/**
 * @file options.js
 * @description 选项与收纳管理中心视图控制器（完全对标 OneTab 并支持 SVG 矢量图标、即地命名、5秒撤销、无感刷新与自动保存）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { StorageKeys } from '../constants/storage-keys.js';
import { LinkModes } from '../constants/config.js';
import { LinkMatcher } from '../core/link/link-matcher.js';
import { MessageBus } from '../core/bus/message-bus.js';

/**
 * Toast 全局通知提示工具（支持 Action 回调与撤销按钮）
 */
class Toast {
  static show(message, duration = 3200, action = null) {
    const el = document.getElementById('toastNotification');
    if (!el) return;

    el.innerHTML = '';
    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    el.appendChild(textSpan);

    if (action && action.text && typeof action.onClick === 'function') {
      const actionBtn = document.createElement('button');
      actionBtn.className = 'toast-action-btn';
      actionBtn.textContent = action.text;
      actionBtn.type = 'button';
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        el.classList.add('hidden');
        action.onClick();
      });
      el.appendChild(actionBtn);
    }

    el.classList.remove('hidden');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      el.classList.add('hidden');
    }, duration);
  }
}

/**
 * 标签收纳箱组件 (StashTabComponent)
 */
class StashTabComponent {
  constructor() {
    this.groups = [];
    this.filteredGroups = [];
    this.renderedGroupCount = 0;
    this.PAGE_SIZE = 15;
    this.TABS_INITIAL_LIMIT = 25;
    this.expandedGroupIds = new Set();
    this.recentlyDeletedGroups = new Map();
    this.searchDebounceTimer = null;
    this.observer = null;

    this.container = document.getElementById('stashGroupsContainer');
    this.emptyState = document.getElementById('stashEmptyState');
    this.badge = document.getElementById('stashCountBadge');
    this.searchInput = document.getElementById('stashSearchInput');
    this.btnSearchClear = document.getElementById('btnStashSearchClear');
    this.btnStashNow = document.getElementById('btnStashNowFromOptions');
    this.sentinel = document.getElementById('stashScrollSentinel');
    this.loadingIndicator = document.getElementById('stashLoadingIndicator');
    this.contextMenu = document.getElementById('stashContextMenu');
    this.activeContextItem = null;

    this.init();
  }

  init() {
    this.bindEvents();
    this.initScrollObserver();
    this.initStorageListener();
    this.loadData();
  }

  /**
   * 监听收纳数据变更与页面可见性（彻底实现 0 刷新即时呈现）
   */
  initStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[StorageKeys.STASH_GROUPS]) {
        const newGroups = changes[StorageKeys.STASH_GROUPS].newValue || [];
        this.groups = Array.isArray(newGroups) ? newGroups : [];
        this.updateBadge();
        this.filterAndRender();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.loadData();
      }
    });
  }

  initScrollObserver() {
    if ('IntersectionObserver' in window && this.sentinel) {
      this.observer = new IntersectionObserver(
        (entries) => {
          if (entries[0] && entries[0].isIntersecting) {
            this.renderNextBatch();
          }
        },
        { root: null, rootMargin: '300px', threshold: 0.01 }
      );
      this.observer.observe(this.sentinel);
    }
  }

  bindEvents() {
    // 1. 搜索输入 200ms 防抖
    this.searchInput?.addEventListener('input', () => {
      clearTimeout(this.searchDebounceTimer);
      if (this.btnSearchClear) {
        if (this.searchInput.value.trim().length > 0) {
          this.btnSearchClear.classList.remove('hidden');
        } else {
          this.btnSearchClear.classList.add('hidden');
        }
      }
      this.searchDebounceTimer = setTimeout(() => {
        this.filterAndRender();
      }, 200);
    });

    // 清空搜索
    this.btnSearchClear?.addEventListener('click', () => {
      this.searchInput.value = '';
      this.btnSearchClear.classList.add('hidden');
      this.filterAndRender();
      this.searchInput.focus();
    });

    // 2. 立即全量收纳当前窗口
    this.btnStashNow?.addEventListener('click', async () => {
      this.btnStashNow.disabled = true;
      Toast.show('正在收纳当前窗口全部标签页...');
      const res = await MessageBus.sendToBackground(ActionTypes.EXECUTE_STASH, { forceAll: true });
      if (res.success && res.data) {
        const { stashedCount } = res.data;
        if (stashedCount > 0) {
          Toast.show(`已全量收纳当前窗口 ${stashedCount} 个标签页`);
        } else {
          Toast.show('当前窗口没有可收纳的网页');
        }
        await this.loadData();
      } else {
        Toast.show(res.error || '收纳失败');
      }
      this.btnStashNow.disabled = false;
    });

    // 3. 全局统一左键事件委托
    this.container?.addEventListener('click', (e) => this.handleContainerClick(e));

    // 4. 组标题双击触发即地重命名
    this.container?.addEventListener('dblclick', (e) => {
      const titleBlock = e.target.closest('.stash-title-block');
      if (titleBlock) {
        const card = titleBlock.closest('.stash-group-card');
        if (card) {
          this.startInlineRename(card.dataset.groupId);
        }
      }
    });

    // 4.5. 图片加载失败静默隐藏回退（捕获阶段代理，彻底杜绝 inline onerror 违反 CSP）
    this.container?.addEventListener(
      'error',
      (e) => {
        if (e.target && e.target.classList?.contains('tab-favicon')) {
          e.target.style.display = 'none';
        }
      },
      true
    );

    // 5. 点击外部自动收起所有“更多...”二级下拉菜单
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dropdown-wrapper')) {
        document.querySelectorAll('.dropdown-wrapper.open').forEach((el) => {
          el.classList.remove('open');
        });
      }
    });

    // 6. 监听右键自定义二级菜单
    this.container?.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.stash-item-row');
      if (row) {
        e.preventDefault();
        const { groupId, itemId } = row.dataset;
        const link = row.querySelector('.tab-link');
        const url = link ? link.getAttribute('href') : '';
        const title = link ? link.textContent.trim() : '';

        this.showContextMenu({
          x: e.clientX,
          y: e.clientY,
          groupId,
          itemId,
          url,
          title
        });
      }
    });

    // 7. 右键菜单内部项操作分发
    if (this.contextMenu) {
      this.contextMenu.addEventListener('click', async (e) => {
        const itemBtn = e.target.closest('.context-menu-item');
        if (!itemBtn || !this.activeContextItem) return;

        const action = itemBtn.dataset.action;
        const { groupId, itemId, url, title } = this.activeContextItem;
        this.hideContextMenu();

        switch (action) {
          case 'open':
            await MessageBus.sendToBackground(ActionTypes.RESTORE_STASH_ITEM, { groupId, itemId });
            await this.loadData();
            break;
          case 'copy-url':
            if (url) {
              await navigator.clipboard.writeText(url);
              Toast.show('已复制链接地址');
            }
            break;
          case 'copy-all':
            if (url) {
              await navigator.clipboard.writeText(`${url} | ${title}`);
              Toast.show('已复制标题与链接');
            }
            break;
          case 'delete':
            this.handleDeleteItemWithAnimation(groupId, itemId);
            break;
        }
      });
    }

    // 8. 关闭右键菜单监听
    document.addEventListener('click', () => this.hideContextMenu());
    window.addEventListener('scroll', () => this.hideContextMenu(), true);
    window.addEventListener('resize', () => this.hideContextMenu());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideContextMenu();
    });
  }

  async loadData() {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_STASH_GROUPS);
    if (res.success && Array.isArray(res.data)) {
      this.groups = res.data;
      this.updateBadge();
      this.filterAndRender();
    }
  }

  updateBadge() {
    const totalTabs = this.groups.reduce((sum, g) => sum + (g.tabs?.length || 0), 0);
    if (this.badge) this.badge.textContent = totalTabs;
  }

  filterAndRender() {
    const query = this.searchInput?.value.toLowerCase().trim() || '';
    this.filteredGroups = this.groups
      .map((grp) => {
        if (!query) return grp;
        const matchedTabs = (grp.tabs || []).filter(
          (t) => (t.title && t.title.toLowerCase().includes(query)) || (t.url && t.url.toLowerCase().includes(query))
        );
        if (matchedTabs.length > 0 || (grp.title && grp.title.toLowerCase().includes(query))) {
          return { ...grp, tabs: query ? matchedTabs : grp.tabs };
        }
        return null;
      })
      .filter(Boolean);

    this.container.innerHTML = '';
    this.renderedGroupCount = 0;

    if (this.filteredGroups.length === 0) {
      this.container.appendChild(this.emptyState);
      this.emptyState.style.display = 'flex';
      if (this.loadingIndicator) this.loadingIndicator.classList.add('hidden');
      return;
    }

    this.emptyState.style.display = 'none';
    this.renderNextBatch();
  }

  renderNextBatch() {
    if (this.renderedGroupCount >= this.filteredGroups.length) {
      if (this.loadingIndicator) this.loadingIndicator.classList.add('hidden');
      return;
    }

    const nextBatch = this.filteredGroups.slice(
      this.renderedGroupCount,
      this.renderedGroupCount + this.PAGE_SIZE
    );

    const query = this.searchInput?.value.toLowerCase().trim() || '';
    const fragment = document.createDocumentFragment();

    nextBatch.forEach((group) => {
      const card = this.createGroupCardElement(group, query);
      fragment.appendChild(card);
    });

    this.container.appendChild(fragment);
    this.renderedGroupCount += nextBatch.length;

    if (this.renderedGroupCount >= this.filteredGroups.length) {
      if (this.loadingIndicator) this.loadingIndicator.classList.add('hidden');
    } else {
      if (this.loadingIndicator) this.loadingIndicator.classList.remove('hidden');
    }
  }

  formatRelativeTime(timestamp) {
    if (!timestamp || typeof timestamp !== 'number') return '';
    const diffMs = Date.now() - timestamp;
    if (diffMs < 0) return '刚刚';
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;
    if (diffHour < 24) return `${diffHour}小时前`;
    if (diffDay < 30) return `${diffDay}天前`;
    return `${Math.floor(diffDay / 30)}个月前`;
  }

  /**
   * 生成单个标签组 DOM 节点
   */
  createGroupCardElement(group, query = '') {
    const card = document.createElement('div');
    card.className = `stash-group-card ${group.locked ? 'is-locked' : ''} ${group.starred ? 'is-starred' : ''}`;
    card.dataset.groupId = group.id;

    const isCustomTitle = Boolean(
      group.title &&
      !group.title.includes('收纳 (') &&
      !group.title.startsWith('OneTab 导入') &&
      group.title !== '导入的标签组' &&
      !group.title.endsWith('个标签页')
    );
    const displayGroupName = isCustomTitle ? group.title : '标签收纳组';
    const tabCount = group.tabs?.length || 0;

    const dateStr = group.createdAt
      ? new Intl.DateTimeFormat('zh-CN', {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(new Date(group.createdAt))
      : '';
    const timeAgo = this.formatRelativeTime(group.createdAt);

    const header = document.createElement('div');
    header.className = 'stash-group-header';
    header.innerHTML = `
      <div class="stash-header-main">
        <div class="stash-title-block" title="点击或双击可重命名标签组">
          <svg class="group-folder-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          ${group.starred ? `
            <svg class="star-icon-svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="none" title="星标置顶" aria-label="星标置顶">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
          ` : ''}
          ${group.locked ? `
            <svg class="lock-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="锁定保护" aria-label="锁定保护">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
          ` : ''}
          <span class="title-text">${this.escapeHTML(displayGroupName)}</span>
          <svg class="edit-hint-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
          </svg>
        </div>

        <div class="stash-meta-badge-row">
          <span class="stash-count-pill">${tabCount} 个标签</span>
          <span class="meta-dot">·</span>
          <span class="stash-time-text" title="${dateStr}">${timeAgo}</span>
        </div>
      </div>

      <div class="stash-header-actions">
        <button class="action-btn btn-restore-all" data-id="${group.id}" type="button" title="在新标签页中还原打开全部 ${tabCount} 个网页">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
          <span>全部还原</span>
        </button>

        <div class="dropdown-wrapper">
          <button class="action-icon-btn btn-more-menu" data-id="${group.id}" type="button" title="更多操作" aria-label="更多操作">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="1"></circle>
              <circle cx="12" cy="5" r="1"></circle>
              <circle cx="12" cy="19" r="1"></circle>
            </svg>
          </button>
          <div class="dropdown-menu" role="menu">
            <button class="dropdown-item btn-rename-group" data-id="${group.id}" type="button" role="menuitem">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
              </svg>
              <span>命名此标签组</span>
            </button>
            <button class="dropdown-item btn-toggle-star" data-id="${group.id}" type="button" role="menuitem">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
              </svg>
              <span>${group.starred ? '取消星标' : '设为星标'}</span>
            </button>
            <button class="dropdown-item btn-toggle-lock" data-id="${group.id}" type="button" role="menuitem">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              <span>${group.locked ? '解锁该组' : '锁定该组'}</span>
            </button>
            <button class="dropdown-item btn-copy-urls" data-id="${group.id}" type="button" role="menuitem">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
              </svg>
              <span>复制全部链接</span>
            </button>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item dropdown-item-danger btn-delete-group" data-id="${group.id}" ${group.locked ? 'disabled title="锁定状态禁止删除"' : ''} type="button" role="menuitem">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              <span>删除此标签组</span>
            </button>
          </div>
        </div>
      </div>
    `;

    const list = document.createElement('div');
    list.className = 'stash-items-list';

    const tabs = group.tabs || [];
    const isExpanded = this.expandedGroupIds.has(group.id) || query.length > 0 || tabs.length <= this.TABS_INITIAL_LIMIT;
    const visibleTabs = isExpanded ? tabs : tabs.slice(0, this.TABS_INITIAL_LIMIT);

    visibleTabs.forEach((tab) => {
      const itemRow = document.createElement('div');
      itemRow.className = 'stash-item-row';
      itemRow.dataset.groupId = group.id;
      itemRow.dataset.itemId = tab.id;

      const faviconSrc = tab.favIconUrl || '';

      itemRow.innerHTML = `
        <div class="stash-item-main">
          ${faviconSrc ? `
            <img src="${this.escapeHTML(faviconSrc)}" class="tab-favicon" loading="lazy" decoding="async" />
          ` : `
            <svg class="tab-favicon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
          `}
          <a href="${this.escapeHTML(tab.url)}" class="tab-link btn-restore-item-link" data-group-id="${group.id}" data-item-id="${tab.id}" title="左键在新标签打开 · 右键弹出选项菜单">
            ${this.escapeHTML(tab.title || tab.url)}
          </a>
        </div>
        <button class="btn-delete-item" data-group-id="${group.id}" data-item-id="${tab.id}" title="从收纳箱移除此项" type="button" aria-label="从收纳箱移除此项">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;
      list.appendChild(itemRow);
    });

    if (tabs.length > this.TABS_INITIAL_LIMIT && !query) {
      const toggleRow = document.createElement('div');
      toggleRow.className = 'stash-toggle-more-row';
      if (!isExpanded) {
        toggleRow.innerHTML = `<button class="btn-toggle-more-tabs btn-expand-group-tabs" data-id="${group.id}">展开剩余 ${tabs.length - this.TABS_INITIAL_LIMIT} 个标签...</button>`;
      } else {
        toggleRow.innerHTML = `<button class="btn-toggle-more-tabs btn-collapse-group-tabs" data-id="${group.id}">收起超长标签列表</button>`;
      }
      list.appendChild(toggleRow);
    }

    card.appendChild(header);
    card.appendChild(list);
    return card;
  }

  /**
   * 启动即地编辑标题 (Inline Rename)
   */
  startInlineRename(groupId) {
    const card = this.container.querySelector(`.stash-group-card[data-group-id="${groupId}"]`);
    if (!card) return;

    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return;

    const titleBlock = card.querySelector('.stash-title-block');
    const titleTextSpan = card.querySelector('.title-text');
    if (!titleBlock || !titleTextSpan) return;

    const isCustomTitle = Boolean(
      group.title &&
      !group.title.includes('收纳 (') &&
      !group.title.startsWith('OneTab 导入') &&
      group.title !== '导入的标签组' &&
      !group.title.endsWith('个标签页')
    );
    const currentTitle = isCustomTitle ? group.title : '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-title-input';
    input.value = currentTitle;
    input.placeholder = '输入标签组名称...';

    titleTextSpan.replaceWith(input);
    input.focus();
    input.select();

    let isSaved = false;
    const save = async () => {
      if (isSaved) return;
      isSaved = true;
      const newTitle = input.value.trim();
      if (newTitle && newTitle !== currentTitle) {
        await MessageBus.sendToBackground(ActionTypes.UPDATE_STASH_GROUP, {
          groupId,
          updates: { title: newTitle }
        });
        Toast.show('已更新组名称');
        await this.loadData();
      } else if (!newTitle && isCustomTitle) {
        await MessageBus.sendToBackground(ActionTypes.UPDATE_STASH_GROUP, {
          groupId,
          updates: { title: '' }
        });
        await this.loadData();
      } else {
        this.refreshGroupCard(groupId);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        isSaved = true;
        this.refreshGroupCard(groupId);
      }
    });

    input.addEventListener('blur', () => save());
  }

  /**
   * 动画平滑删除单项标签
   */
  async handleDeleteItemWithAnimation(groupId, itemId) {
    const row = this.container.querySelector(`.stash-item-row[data-group-id="${groupId}"][data-item-id="${itemId}"]`);
    if (row) {
      row.classList.add('is-deleting');
    }

    setTimeout(async () => {
      await MessageBus.sendToBackground(ActionTypes.DELETE_STASH_ITEM, { groupId, itemId });
      Toast.show('已从收纳箱移除');

      const targetGroup = this.groups.find((g) => g.id === groupId);
      if (targetGroup) {
        targetGroup.tabs = targetGroup.tabs.filter((t) => t.id !== itemId);
        if (row) row.remove();
        this.updateBadge();
        if (targetGroup.tabs.length === 0 && !targetGroup.locked) {
          const card = this.container.querySelector(`.stash-group-card[data-group-id="${groupId}"]`);
          if (card) card.remove();
          this.groups = this.groups.filter((g) => g.id !== groupId);
          if (this.groups.length === 0) {
            this.filterAndRender();
          }
        } else {
          this.refreshGroupCard(groupId);
        }
      }
    }, 180);
  }

  showContextMenu({ x, y, groupId, itemId, url, title }) {
    if (!this.contextMenu) return;
    this.activeContextItem = { groupId, itemId, url, title };
    this.contextMenu.classList.remove('hidden');

    const menuWidth = this.contextMenu.offsetWidth || 170;
    const menuHeight = this.contextMenu.offsetHeight || 160;

    let posX = x;
    let posY = y;

    if (posX + menuWidth > window.innerWidth) posX = window.innerWidth - menuWidth - 10;
    if (posY + menuHeight > window.innerHeight) posY = window.innerHeight - menuHeight - 10;

    this.contextMenu.style.left = `${Math.max(10, posX)}px`;
    this.contextMenu.style.top = `${Math.max(10, posY)}px`;
  }

  hideContextMenu() {
    if (this.contextMenu && !this.contextMenu.classList.contains('hidden')) {
      this.contextMenu.classList.add('hidden');
      this.activeContextItem = null;
    }
  }

  refreshGroupCard(groupId) {
    const existingCard = this.container.querySelector(`.stash-group-card[data-group-id="${groupId}"]`);
    if (!existingCard) return;

    const group = this.groups.find((g) => g.id === groupId);
    if (!group) {
      existingCard.remove();
      return;
    }

    const query = this.searchInput?.value.toLowerCase().trim() || '';
    const newCard = this.createGroupCardElement(group, query);
    existingCard.replaceWith(newCard);
  }

  async handleContainerClick(e) {
    const target = e.target;

    // 0. 切换二级菜单
    const btnMore = target.closest('.btn-more-menu');
    if (btnMore) {
      e.stopPropagation();
      const wrapper = btnMore.closest('.dropdown-wrapper');
      if (wrapper) {
        const wasOpen = wrapper.classList.contains('open');
        document.querySelectorAll('.dropdown-wrapper.open').forEach((el) => el.classList.remove('open'));
        if (!wasOpen) wrapper.classList.add('open');
      }
      return;
    }

    document.querySelectorAll('.dropdown-wrapper.open').forEach((el) => el.classList.remove('open'));

    // 1. 恢复整组
    const btnRestoreAll = target.closest('.btn-restore-all');
    if (btnRestoreAll) {
      const groupId = btnRestoreAll.dataset.id;
      const card = btnRestoreAll.closest('.stash-group-card');
      btnRestoreAll.disabled = true;
      await MessageBus.sendToBackground(ActionTypes.RESTORE_STASH_GROUP, { groupId });
      Toast.show('已恢复该标签组全部页面');

      const targetGroup = this.groups.find((g) => g.id === groupId);
      if (targetGroup && !targetGroup.locked) {
        this.groups = this.groups.filter((g) => g.id !== groupId);
        if (card) card.remove();
        this.updateBadge();
        if (this.groups.length === 0) this.filterAndRender();
      } else {
        await this.loadData();
      }
      return;
    }

    // 2. 即地命名
    const btnRename = target.closest('.btn-rename-group');
    if (btnRename) {
      this.startInlineRename(btnRename.dataset.id);
      return;
    }

    // 3. 切换星标
    const btnToggleStar = target.closest('.btn-toggle-star');
    if (btnToggleStar) {
      const groupId = btnToggleStar.dataset.id;
      const targetGroup = this.groups.find((g) => g.id === groupId);
      if (targetGroup) {
        await MessageBus.sendToBackground(ActionTypes.UPDATE_STASH_GROUP, {
          groupId,
          updates: { starred: !targetGroup.starred }
        });
        Toast.show(targetGroup.starred ? '已取消星标' : '已设为星标');
        await this.loadData();
      }
      return;
    }

    // 4. 切换锁定
    const btnToggleLock = target.closest('.btn-toggle-lock');
    if (btnToggleLock) {
      const groupId = btnToggleLock.dataset.id;
      const targetGroup = this.groups.find((g) => g.id === groupId);
      if (targetGroup) {
        await MessageBus.sendToBackground(ActionTypes.UPDATE_STASH_GROUP, {
          groupId,
          updates: { locked: !targetGroup.locked }
        });
        Toast.show(targetGroup.locked ? '已解锁' : '已锁定（恢复后将保留不被删除）');
        await this.loadData();
      }
      return;
    }

    // 5. 复制全部链接
    const btnCopy = target.closest('.btn-copy-urls');
    if (btnCopy) {
      const groupId = btnCopy.dataset.id;
      const targetGroup = this.groups.find((g) => g.id === groupId);
      if (targetGroup && targetGroup.tabs) {
        const text = targetGroup.tabs.map((t) => `${t.url} | ${t.title}`).join('\n');
        await navigator.clipboard.writeText(text);
        Toast.show('已复制该组内所有链接到剪贴板');
      }
      return;
    }

    // 6. 删除整组（支持 5 秒撤销）
    const btnDeleteGroup = target.closest('.btn-delete-group');
    if (btnDeleteGroup) {
      const groupId = btnDeleteGroup.dataset.id;
      const targetGroup = this.groups.find((g) => g.id === groupId);
      if (!targetGroup) return;

      const card = btnDeleteGroup.closest('.stash-group-card');
      const backupGroup = JSON.parse(JSON.stringify(targetGroup));

      await MessageBus.sendToBackground(ActionTypes.DELETE_STASH_GROUP, { groupId });
      this.groups = this.groups.filter((g) => g.id !== groupId);
      if (card) card.remove();
      this.updateBadge();
      if (this.groups.length === 0) this.filterAndRender();

      Toast.show(`已删除标签组 (${backupGroup.tabs?.length || 0} 个网页)`, 5000, {
        text: '撤销',
        onClick: async () => {
          const lines = backupGroup.tabs.map((t) => `${t.url} | ${t.title}`).join('\n');
          await MessageBus.sendToBackground(ActionTypes.IMPORT_THIRD_PARTY_DATA, { textString: lines });
          Toast.show('已成功恢复该标签组');
          await this.loadData();
        }
      });
      return;
    }

    // 7. 单项恢复打开
    const linkRestore = target.closest('.btn-restore-item-link');
    if (linkRestore) {
      e.preventDefault();
      const { groupId, itemId } = linkRestore.dataset;
      await MessageBus.sendToBackground(ActionTypes.RESTORE_STASH_ITEM, { groupId, itemId });
      Toast.show('已在新标签打开');

      const targetGroup = this.groups.find((g) => g.id === groupId);
      if (targetGroup && !targetGroup.locked) {
        targetGroup.tabs = targetGroup.tabs.filter((t) => t.id !== itemId);
        const row = linkRestore.closest('.stash-item-row');
        if (row) row.remove();
        this.updateBadge();
        if (targetGroup.tabs.length === 0) {
          const card = linkRestore.closest('.stash-group-card');
          if (card) card.remove();
          this.groups = this.groups.filter((g) => g.id !== groupId);
          if (this.groups.length === 0) this.filterAndRender();
        } else {
          this.refreshGroupCard(groupId);
        }
      }
      return;
    }

    // 8. 单项平滑删除
    const btnDeleteItem = target.closest('.btn-delete-item');
    if (btnDeleteItem) {
      const { groupId, itemId } = btnDeleteItem.dataset;
      this.handleDeleteItemWithAnimation(groupId, itemId);
      return;
    }

    // 9. 展开超长标签列表
    const btnExpand = target.closest('.btn-expand-group-tabs');
    if (btnExpand) {
      const groupId = btnExpand.dataset.id;
      this.expandedGroupIds.add(groupId);
      this.refreshGroupCard(groupId);
      return;
    }

    // 10. 收起超长标签列表
    const btnCollapse = target.closest('.btn-collapse-group-tabs');
    if (btnCollapse) {
      const groupId = btnCollapse.dataset.id;
      this.expandedGroupIds.delete(groupId);
      this.refreshGroupCard(groupId);
      return;
    }
  }

  escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

/**
 * 智能规则配置组件 (RulesConfigComponent - 实时 Auto-save)
 */
class RulesConfigComponent {
  constructor() {
    this.dom = {
      inputTabThreshold: document.getElementById('inputTabThreshold'),
      inputRecentMinutes: document.getElementById('inputRecentMinutes'),
      chkAutoStash: document.getElementById('chkAutoStash'),
      inputCountdownSeconds: document.getElementById('inputCountdownSeconds'),
      chkAutoNotify: document.getElementById('chkAutoNotify'),
      chkRuleAudible: document.getElementById('chkRuleAudible'),
      chkRuleFormGuard: document.getElementById('chkRuleFormGuard'),
      chkRuleRecentActive: document.getElementById('chkRuleRecentActive'),
      chkRuleHighFrequency: document.getElementById('chkRuleHighFrequency'),
      chkRulePinned: document.getElementById('chkRulePinned'),
      autoSaveIndicator: document.getElementById('rulesAutoSaveIndicator')
    };

    this.debounceTimer = null;
    this.init();
  }

  async init() {
    this.bindAutoSaveEvents();
    this.initStorageListener();
    await this.loadConfig();
  }

  /**
   * 监听全局配置变更（若非当前正在编辑中则静默同步最新状态）
   */
  initStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[StorageKeys.USER_CONFIG]) {
        if (!this.debounceTimer) {
          this.loadConfig();
        }
      }
    });
  }

  bindAutoSaveEvents() {
    const triggerSave = () => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.saveConfig(), 250);
    };

    this.dom.inputTabThreshold?.addEventListener('input', triggerSave);
    this.dom.inputRecentMinutes?.addEventListener('input', triggerSave);
    this.dom.chkAutoStash?.addEventListener('change', triggerSave);
    this.dom.inputCountdownSeconds?.addEventListener('input', triggerSave);
    this.dom.chkAutoNotify?.addEventListener('change', triggerSave);
    this.dom.chkRuleAudible?.addEventListener('change', triggerSave);
    this.dom.chkRuleFormGuard?.addEventListener('change', triggerSave);
    this.dom.chkRuleRecentActive?.addEventListener('change', triggerSave);
    this.dom.chkRuleHighFrequency?.addEventListener('change', triggerSave);
    this.dom.chkRulePinned?.addEventListener('change', triggerSave);
  }

  async loadConfig() {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_CONFIG);
    if (res.success && res.data) {
      const cfg = res.data;
      if (this.dom.inputTabThreshold) this.dom.inputTabThreshold.value = cfg.tabThreshold || 15;
      if (this.dom.inputRecentMinutes) this.dom.inputRecentMinutes.value = cfg.recentActiveMinutes || 5;
      if (this.dom.chkAutoStash) this.dom.chkAutoStash.checked = cfg.autoStashOnThreshold !== false;
      if (this.dom.inputCountdownSeconds) this.dom.inputCountdownSeconds.value = cfg.countdownSeconds || 15;
      if (this.dom.chkAutoNotify) this.dom.chkAutoNotify.checked = Boolean(cfg.autoThresholdNotify);

      const rules = cfg.rulesEnabled || {};
      if (this.dom.chkRuleAudible) this.dom.chkRuleAudible.checked = rules.audible !== false;
      if (this.dom.chkRuleFormGuard) this.dom.chkRuleFormGuard.checked = rules.formGuard !== false;
      if (this.dom.chkRuleRecentActive) this.dom.chkRuleRecentActive.checked = rules.recentActive !== false;
      if (this.dom.chkRuleHighFrequency) this.dom.chkRuleHighFrequency.checked = rules.highFrequency !== false;
      if (this.dom.chkRulePinned) this.dom.chkRulePinned.checked = rules.pinned !== false;
    }
  }

  async saveConfig() {
    const threshold = parseInt(this.dom.inputTabThreshold?.value, 10) || 15;
    const recentMin = parseInt(this.dom.inputRecentMinutes?.value, 10) || 5;
    const countdownSec = parseInt(this.dom.inputCountdownSeconds?.value, 10) || 15;

    const payload = {
      tabThreshold: Math.max(5, threshold),
      recentActiveMinutes: Math.max(1, recentMin),
      autoStashOnThreshold: this.dom.chkAutoStash ? this.dom.chkAutoStash.checked : true,
      countdownSeconds: Math.max(3, countdownSec),
      autoThresholdNotify: this.dom.chkAutoNotify ? this.dom.chkAutoNotify.checked : true,
      rulesEnabled: {
        audible: this.dom.chkRuleAudible ? this.dom.chkRuleAudible.checked : true,
        formGuard: this.dom.chkRuleFormGuard ? this.dom.chkRuleFormGuard.checked : true,
        recentActive: this.dom.chkRuleRecentActive ? this.dom.chkRuleRecentActive.checked : true,
        highFrequency: this.dom.chkRuleHighFrequency ? this.dom.chkRuleHighFrequency.checked : true,
        pinned: this.dom.chkRulePinned ? this.dom.chkRulePinned.checked : true
      }
    };

    const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, payload);
    if (res.success) {
      if (this.dom.autoSaveIndicator) {
        this.dom.autoSaveIndicator.style.opacity = '1';
      }
    }
  }
}

/**
 * 域名跳转规则管理组件 (DomainRulesComponent)
 */
class DomainRulesComponent {
  constructor() {
    this.dom = {
      chkGlobalRule: document.getElementById('chkGlobalLinkRule'),
      selectGlobalMode: document.getElementById('selectGlobalLinkMode'),
      globalNoticeBanner: document.getElementById('globalOverrideNoticeBanner'),
      tbody: document.getElementById('domainRulesTbody'),
      inputDomain: document.getElementById('inputNewDomain'),
      selectMode: document.getElementById('selectNewDomainMode'),
      btnAdd: document.getElementById('btnAddDomainRule'),
      btnClearAll: document.getElementById('btnClearAllDomainRules')
    };

    this.init();
  }

  init() {
    this.dom.chkGlobalRule?.addEventListener('change', () => this.saveGlobalRule());
    this.dom.selectGlobalMode?.addEventListener('change', () => this.saveGlobalRule());

    this.dom.btnAdd?.addEventListener('click', () => this.handleAddRule());
    this.dom.inputDomain?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleAddRule();
      }
    });

    this.dom.btnClearAll?.addEventListener('click', () => this.handleClearAll());
    this.initStorageListener();
    this.loadRules();
  }

  /**
   * 监听独立域名规则与全局跳转设置变更（实时响应）
   */
  initStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && (changes[StorageKeys.LINK_RULES] || changes[StorageKeys.USER_CONFIG])) {
        this.loadRules();
      }
    });
  }

  async loadRules() {
    const globalRes = await MessageBus.sendToBackground(ActionTypes.GET_GLOBAL_LINK_RULE);
    if (globalRes.success && globalRes.data) {
      const isEnabled = Boolean(globalRes.data.enabled);
      if (this.dom.chkGlobalRule) this.dom.chkGlobalRule.checked = isEnabled;
      if (this.dom.selectGlobalMode && globalRes.data.mode) this.dom.selectGlobalMode.value = globalRes.data.mode;
      this.updateGlobalNotice(isEnabled);
    }

    chrome.storage.local.get(['bb_link_rules'], (result) => {
      const rules = result.bb_link_rules || {};
      this.renderTable(rules);
    });
  }

  updateGlobalNotice(isEnabled) {
    if (this.dom.globalNoticeBanner) {
      if (isEnabled) {
        this.dom.globalNoticeBanner.classList.remove('hidden');
      } else {
        this.dom.globalNoticeBanner.classList.add('hidden');
      }
    }
  }

  async saveGlobalRule() {
    const enabled = this.dom.chkGlobalRule ? this.dom.chkGlobalRule.checked : false;
    const mode = this.dom.selectGlobalMode ? this.dom.selectGlobalMode.value : LinkModes.AUTO;

    const res = await MessageBus.sendToBackground(ActionTypes.SET_GLOBAL_LINK_RULE, { enabled, mode });
    if (res.success) {
      this.updateGlobalNotice(enabled);
      Toast.show(enabled ? `已启用全局跳转覆盖（模式: ${mode}）` : '已关闭全局跳转覆盖（遵循独立域名设置）');
    } else {
      Toast.show('更新全局规则失败');
    }
  }

  renderTable(rules) {
    this.dom.tbody.innerHTML = '';
    const domains = Object.keys(rules);

    if (domains.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="3" style="text-align: center; color: var(--text-muted); padding: 32px 0;">暂无配置独立规则的网站域名</td>`;
      this.dom.tbody.appendChild(tr);
      return;
    }

    const modeLabels = {
      auto: { label: '自动模式', class: 'auto' },
      current: { label: '当前标签打开', class: 'current' },
      new: { label: '新标签页打开', class: 'new' }
    };

    domains.forEach((domain) => {
      const mode = rules[domain];
      const modeInfo = modeLabels[mode] || modeLabels.auto;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${this.escapeHTML(domain)}</strong></td>
        <td><span class="badge-mode ${modeInfo.class}">${modeInfo.label}</span></td>
        <td style="text-align: right;">
          <button class="btn btn-danger btn-sm btn-delete-domain" data-domain="${this.escapeHTML(domain)}" type="button">
            删除
          </button>
        </td>
      `;
      this.dom.tbody.appendChild(tr);
    });

    this.dom.tbody.querySelectorAll('.btn-delete-domain').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const domain = btn.dataset.domain;
        await MessageBus.sendToBackground(ActionTypes.SET_LINK_RULE, {
          domain: domain,
          mode: LinkModes.AUTO
        });
        Toast.show(`已删除域名规则: ${domain}`);
        this.loadRules();
      });
    });
  }

  async handleAddRule() {
    const rawDomain = this.dom.inputDomain.value.trim();
    if (!rawDomain) {
      Toast.show('请输入有效的网站域名');
      return;
    }

    // 智能提取纯域名（容错处理 https:// / 路径）
    let cleanDomain = LinkMatcher.extractDomain(rawDomain.startsWith('http') ? rawDomain : `https://${rawDomain}`);
    if (!cleanDomain) cleanDomain = rawDomain.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];

    const mode = this.dom.selectMode.value;
    await MessageBus.sendToBackground(ActionTypes.SET_LINK_RULE, { domain: cleanDomain, mode });
    this.dom.inputDomain.value = '';
    Toast.show(`已成功添加域名规则: ${cleanDomain}`);
    this.loadRules();
  }

  async handleClearAll() {
    const ok = window.confirm('⚠️ 警告：确定要清空所有已保存的网站独立跳转规则吗？');
    if (!ok) return;
    chrome.storage.local.set({ bb_link_rules: {} }, () => {
      Toast.show('已清空所有域名规则');
      this.loadRules();
    });
  }

  escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
  }
}

/**
 * 数据备份与迁移管理组件 (BackupComponent)
 */
class BackupComponent {
  constructor(onDataChanged) {
    this.onDataChanged = onDataChanged;
    this.dom = {
      restoreTextarea: document.getElementById('restoreJSONTextarea'),
      fileRestoreJSON: document.getElementById('fileRestoreJSON'),
      btnRestoreFromText: document.getElementById('btnRestoreFromText'),
      btnExportFullJSON: document.getElementById('btnExportFullJSON'),
      btnCopyFullJSON: document.getElementById('btnCopyFullJSON'),
      importThirdPartyTextarea: document.getElementById('importThirdPartyTextarea'),
      fileImportThirdParty: document.getElementById('fileImportThirdParty'),
      btnImportThirdPartyText: document.getElementById('btnImportThirdPartyText'),
      btnExportOneTabText: document.getElementById('btnExportOneTabText'),
      btnCopyOneTabText: document.getElementById('btnCopyOneTabText'),
      btnClearAllStash: document.getElementById('btnClearAllStash')
    };

    this.init();
  }

  init() {
    // 1. 恢复全量数据
    this.dom.btnRestoreFromText?.addEventListener('click', async () => {
      const text = this.dom.restoreTextarea.value.trim();
      if (!text) {
        Toast.show('请在输入框中粘贴 BetterBrowse 备份 JSON 数据');
        return;
      }
      this.dom.btnRestoreFromText.disabled = true;
      Toast.show('正在解析并恢复全量数据...');

      const res = await MessageBus.sendToBackground(ActionTypes.RESTORE_FULL_BACKUP, { jsonString: text });
      if (res.success && res.data) {
        const { importedCount, groupCount, restoredConfig, restoredRules } = res.data;
        let msg = `成功恢复 ${groupCount} 个标签组 (${importedCount} 个标签)`;
        if (restoredConfig || restoredRules) msg += '，并已还原所有配置与规则！';
        Toast.show(msg, 4000);
        this.dom.restoreTextarea.value = '';
        if (this.onDataChanged) this.onDataChanged();
      } else {
        Toast.show(`恢复失败: ${res.error || '无法解析备份数据'}`);
      }
      this.dom.btnRestoreFromText.disabled = false;
    });

    this.dom.fileRestoreJSON?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (evt) => {
        const content = evt.target.result;
        Toast.show('正在从文件解析并恢复全量数据...');
        const res = await MessageBus.sendToBackground(ActionTypes.RESTORE_FULL_BACKUP, { jsonString: content });
        if (res.success && res.data) {
          const { importedCount, groupCount, restoredConfig, restoredRules } = res.data;
          let msg = `成功从文件恢复 ${groupCount} 个标签组 (${importedCount} 个标签)`;
          if (restoredConfig || restoredRules) msg += '，并已还原所有配置与规则！';
          Toast.show(msg, 4000);
          if (this.onDataChanged) this.onDataChanged();
        } else {
          Toast.show(`恢复失败: ${res.error || '文件解析失败'}`);
        }
      };
      reader.readAsText(file, 'UTF-8');
      this.dom.fileRestoreJSON.value = '';
    });

    // 2. 备份全量数据
    this.dom.btnExportFullJSON?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_FULL_BACKUP);
      if (res.success && res.data) {
        const blob = new Blob([res.data], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `BetterBrowse_Full_Backup_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        Toast.show('全量 JSON 备份文件已成功下载！');
      }
    });

    this.dom.btnCopyFullJSON?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_FULL_BACKUP);
      if (res.success && res.data) {
        await navigator.clipboard.writeText(res.data);
        Toast.show('全量 JSON 备份数据已复制到剪贴板！');
      }
    });

    // 3. 从第三方导入数据
    this.dom.btnImportThirdPartyText?.addEventListener('click', async () => {
      const text = this.dom.importThirdPartyTextarea.value.trim();
      if (!text) {
        Toast.show('请在输入框中粘贴 OneTab 纯文本或网址列表');
        return;
      }
      this.dom.btnImportThirdPartyText.disabled = true;
      Toast.show('正在智能识别并导入标签页...');

      const res = await MessageBus.sendToBackground(ActionTypes.IMPORT_THIRD_PARTY_DATA, { textString: text });
      if (res.success && res.data) {
        const { importedCount, groupCount, formatName } = res.data;
        Toast.show(`成功以【${formatName}】导入 ${importedCount} 个标签 (${groupCount} 个组)！`, 3500);
        this.dom.importThirdPartyTextarea.value = '';
        if (this.onDataChanged) this.onDataChanged();
      } else {
        Toast.show(`导入失败: ${res.error || '无法解析有效数据'}`);
      }
      this.dom.btnImportThirdPartyText.disabled = false;
    });

    this.dom.fileImportThirdParty?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (evt) => {
        const content = evt.target.result;
        const res = await MessageBus.sendToBackground(ActionTypes.IMPORT_THIRD_PARTY_DATA, { textString: content });
        if (res.success && res.data) {
          const { importedCount, groupCount, formatName } = res.data;
          Toast.show(`成功从文件以【${formatName}】导入 ${importedCount} 个标签 (${groupCount} 个组)！`, 3500);
          if (this.onDataChanged) this.onDataChanged();
        } else {
          Toast.show(`导入失败: ${res.error || '文件解析失败'}`);
        }
      };
      reader.readAsText(file, 'UTF-8');
      this.dom.fileImportThirdParty.value = '';
    });

    this.dom.btnExportOneTabText?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_ONETAB_TEXT);
      if (res.success && res.data) {
        const blob = new Blob([res.data], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `BetterBrowse_OneTab_Export_${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        Toast.show('OneTab 格式纯文本已成功下载！');
      }
    });

    this.dom.btnCopyOneTabText?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_ONETAB_TEXT);
      if (res.success && res.data) {
        await navigator.clipboard.writeText(res.data);
        Toast.show('OneTab 兼容格式文本已复制到剪贴板！');
      }
    });

    // 4. 清空非锁定收纳
    this.dom.btnClearAllStash?.addEventListener('click', async () => {
      const ok = window.confirm('⚠️ 警告：确定要清空收纳箱内所有历史记录吗？\n（锁定保护的标签组将安全保留，其他数据将被清除且不可撤销）');
      if (!ok) return;
      await MessageBus.sendToBackground(ActionTypes.CLEAR_ALL_STASH);
      Toast.show('非锁定收纳数据已清空（锁定组已安全保留）');
      if (this.onDataChanged) this.onDataChanged();
    });
  }
}

/**
 * 仪表盘总协调应用 (OptionsApp)
 */
class OptionsApp {
  constructor() {
    this.navItems = document.querySelectorAll('.nav-item');
    this.panels = document.querySelectorAll('.tab-panel');

    this.init();
  }

  init() {
    this.bindNavigation();

    const stashComponent = new StashTabComponent();
    const rulesComponent = new RulesConfigComponent();
    const domainComponent = new DomainRulesComponent();
    new BackupComponent(() => {
      stashComponent.loadData();
      rulesComponent.loadConfig();
      domainComponent.loadRules();
    });

    // 接收来自后台的主动广播通知（双通道保障即时呈现）
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.action) return false;
      if (message.action === ActionTypes.NOTIFY_STASH_UPDATED) {
        stashComponent.loadData();
      } else if (message.action === ActionTypes.NOTIFY_RULE_UPDATED) {
        domainComponent.loadRules();
      } else if (message.action === ActionTypes.NOTIFY_CONFIG_UPDATED) {
        rulesComponent.loadConfig();
      }
      return false;
    });

    this.handleInitialHash();
    window.addEventListener('hashchange', () => this.handleInitialHash());
  }

  handleInitialHash() {
    const rawHash = (window.location.hash || '').replace('#', '').trim();
    if (rawHash && document.getElementById(`tab-${rawHash}`)) {
      this.switchTab(rawHash, false);
    }
  }

  bindNavigation() {
    this.navItems.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;
        this.switchTab(targetTab);
      });
    });
  }

  switchTab(tabName, updateHash = true) {
    if (!tabName) return;

    this.navItems.forEach((btn) => {
      if (btn.dataset.tab === tabName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    this.panels.forEach((panel) => {
      if (panel.id === `tab-${tabName}`) {
        panel.classList.add('active');
      } else {
        panel.classList.remove('active');
      }
    });

    if (updateHash && window.location.hash !== `#${tabName}`) {
      history.replaceState(null, '', `#${tabName}`);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new OptionsApp();
});
