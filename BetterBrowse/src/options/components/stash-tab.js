/**
 * @file stash-tab.js
 * @description 选项页组件模块
 * @encoding UTF-8
 */

import { ActionTypes } from '../../constants/action-types.js';
import { StorageKeys } from '../../constants/storage-keys.js';
import { MessageBus } from '../../core/bus/message-bus.js';
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
import { TimeTreeBuilder, SingleLineTimelineScrollbar } from '../ui/time-tree.js';
import { describeStashResult } from '../../core/stash/stash-result.js';
import { escapeHTML, formatTimeAgo, headerSignature, renderGroupCardHtml, renderItemRowHtml } from './stash-card.js';
import { FaviconResolver } from './stash-favicons.js';

/** 卡片内按钮 → 处理方法（按顺序匹配第一个命中的选择器） */
const CARD_CLICK_ACTIONS = [
  ['.btn-restore-all', 'restoreWholeGroup'],
  ['.btn-toggle-dropdown', 'toggleGroupDropdown'],
  ['.btn-delete-group', 'deleteGroupWithUndo'],
  ['.btn-toggle-star', 'toggleGroupStar'],
  ['.btn-toggle-lock', 'toggleGroupLock'],
  ['.btn-rename-group', 'renameGroupFromButton'],
  ['.btn-copy-group-urls', 'copyGroupUrls'],
  ['.btn-restore-item-link', 'restoreSingleItem'],
  ['.btn-delete-item', 'deleteItemFromButton'],
  ['.btn-edit-item', 'editItemFromButton'],
  ['.btn-show-more-tabs', 'expandGroupItems']
];

export class StashTabComponent {
  /**
   * @param {object} [options]
   * @param {(scope?: string) => void} [options.onSearchInHome] 跳转主页搜索的统一入口
   */
  constructor(options = {}) {
    this.groups = [];
    this.filteredGroups = [];
    this.groupPages = new Map();
    this.expandedGroupIds = new Set();
    this.pinnedGroupIds = new Set();
    this.recentlyDeletedGroups = new Map();
    this.activeTimeRangeFilter = null;
    this.loadGeneration = 0;
    this.mountedRange = null;
    this.measuredCardHeights = new Map();
    this.itemWindowByGroup = new Map();
    this.pageLoaders = new Map();
    this.windowSyncTicking = false;
    // 站点图标解析器（自带结果缓存，失败亦缓存，避免反复抓取）
    this.favicons = new FaviconResolver(() => this.container);
    this.onSearchInHome = typeof options.onSearchInHome === 'function' ? options.onSearchInHome : null;

    this.container = document.getElementById('stashGroupsContainer');
    this.mainColumn = document.querySelector('.stash-main-column');
    this.emptyState = document.getElementById('stashEmptyState');
    this.badge = document.getElementById('stashCountBadge');
    this.btnSearchInHome = document.getElementById('btnStashSearchInHome');
    this.btnStashNow = document.getElementById('btnStashNowFromOptions');
    this.contextMenu = document.getElementById('stashContextMenu');
    this.activeContextItem = null;
    this.topSpacer = null;
    this.bottomSpacer = null;

    // 单线时间滚动条相关 DOM
    this.timelineScrollbarTrack = document.getElementById('timelineScrollbar');
    this.timelineNodesContainer = document.getElementById('timelineNodesContainer');
    this.timelineScrubberThumb = document.getElementById('timelineScrubberThumb');

    // 实例化单一直线时间轴分块滚动条组件
    this.timelineScrollbar = new SingleLineTimelineScrollbar({
      container: this.timelineNodesContainer,
      track: this.timelineScrollbarTrack,
      thumb: this.timelineScrubberThumb,
      onSelectChunk: (node) => {
        if (node) {
          this.setTimeRangeFilter(node);
        } else {
          this.clearTimeRangeFilter();
        }
      }
    });

    this.init();
  }

  init() {
    this.bindEvents();
    this.initScrollSpy();
    this.initStorageListener();
    this.loadData();
  }

  /**
   * 初始化滚动监听（ScrollSpy），实时驱动右侧时间线活动节点高亮
   */
  initScrollSpy() {
    if (!this.mainColumn) return;
    let ticking = false;
    this.mainColumn.addEventListener(
      'scroll',
      () => {
        if (!ticking) {
          window.requestAnimationFrame(() => {
            this.syncListWindow();
            this.checkScrollSpy();
            ticking = false;
          });
          ticking = true;
        }
      },
      { passive: true }
    );
  }

  /**
   * 检查当前位于视口顶部的收纳组并同步高亮时间线对应节点与游标
   */
  checkScrollSpy() {
    if (!this.filteredGroups || this.filteredGroups.length === 0 || !this.mainColumn) return;
    const maxScroll = this.mainColumn.scrollHeight - this.mainColumn.clientHeight;
    const ratio = maxScroll > 0 ? this.mainColumn.scrollTop / maxScroll : 0;

    const containerRect = this.mainColumn.getBoundingClientRect();
    const cards = this.container.querySelectorAll('.stash-group-card');
    if (cards.length === 0) {
      this.timelineScrollbar.syncScrollProgress(ratio, null);
      return;
    }

    let topCard = null;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      // 距离滚动容器顶部 20px 以上，视为主视口顶部活动卡片
      if (rect.bottom >= containerRect.top + 20) {
        topCard = card;
        break;
      }
    }
    if (!topCard && cards.length > 0) {
      topCard = cards[0];
    }
    if (topCard) {
      const groupId = topCard.dataset.groupId;
      this.timelineScrollbar.syncScrollProgress(ratio, groupId);
    }
  }

  /**
   * 监听收纳数据变更与页面可见性（彻底实现 0 刷新即时呈现）
   */
  initStorageListener() {
    if (!chrome.storage?.onChanged?.addListener) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      // IndexedDB 主库模式下收纳数据不再经过 chrome.storage，
      // 通过修订号（bb_stash_revision）感知变化并重新拉取权威数据
      if (changes[StorageKeys.STASH_REV]) {
        this.loadData();
        return;
      }
      // 旧存储回退模式：直接使用变更数组即时呈现
      if (changes[StorageKeys.STASH_GROUPS]) {
        const newGroups = changes[StorageKeys.STASH_GROUPS].newValue || [];
        const raw = Array.isArray(newGroups)
          ? newGroups.filter((group) => group && typeof group === 'object')
          : [];
        this.ingestSummaries(raw.map((group) => StashTabComponent.toSummary(group)), raw);
        this.timelineScrollbar.update(this.groups);
        this.syncTimeFilterSnapshot();
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

  bindEvents() {
    // 1. 统一搜索入口：时间线不再内置搜索框，交由主页承载全部检索
    this.btnSearchInHome?.addEventListener('click', () => this.openHomeSearch());

    // 立即收纳当前窗口全部标签页
    this.btnStashNow?.addEventListener('click', async () => {
      this.btnStashNow.disabled = true;
      Toast.show('正在收纳本窗口标签…');
      const res = await MessageBus.sendToBackground(ActionTypes.EXECUTE_STASH, { forceAll: true });
      const result = describeStashResult(res);
      Toast.show(result.message);
      if (result.ok) await this.loadData();
      this.btnStashNow.disabled = false;
    });

    // 3. 主列表边界滚动（触顶或触底继续滚动）自动联动切换时段
    let lastBoundaryScrollTime = 0;
    this.mainColumn?.addEventListener(
      'wheel',
      (e) => {
        if (this.timelineScrollbar.activeChunkIndex === -1) return;
        const now = Date.now();
        if (now - lastBoundaryScrollTime < 450) return;

        const maxScroll = this.mainColumn.scrollHeight - this.mainColumn.clientHeight;
        if (this.mainColumn.scrollTop <= 0 && e.deltaY < -30) {
          if (this.timelineScrollbar.activeChunkIndex > 0) {
            lastBoundaryScrollTime = now;
            this.timelineScrollbar.stepPrevChunk();
            Toast.show(`已切换至：${this.timelineScrollbar.getCurrentChunk().title}`);
          }
        } else if (this.mainColumn.scrollTop >= maxScroll - 5 && e.deltaY > 30) {
          if (this.timelineScrollbar.activeChunkIndex < this.timelineScrollbar.chunks.length - 1) {
            lastBoundaryScrollTime = now;
            this.timelineScrollbar.stepNextChunk();
            Toast.show(`已切换至：${this.timelineScrollbar.getCurrentChunk().title}`);
          }
        }
      },
      { passive: true }
    );

    // 4. 全局统一左键事件委托
    this.container?.addEventListener('click', (e) => this.handleContainerClick(e));

    // 5. 组标题双击触发即地重命名
    this.container?.addEventListener('dblclick', (e) => {
      const titleBlock = e.target.closest('.stash-title-block');
      if (titleBlock) {
        const card = titleBlock.closest('.stash-group-card');
        if (card) {
          this.startInlineRename(card.dataset.groupId);
        }
      }
    });

    // 6. 站点图标经后台解析为 data URL，避免扩展页直连第三方触发 PNA/CORS 与归档历史泄露
    this.container?.addEventListener(
      'click',
      () => this.favicons.resolveVisible(),
      true
    );

    // 图标加载失败时回退为默认网页 SVG 图标，保持对齐排版
    this.container?.addEventListener(
      'error',
      (e) => {
        const target = e.target;
        if (target && target.tagName === 'IMG' && target.classList?.contains('tab-favicon')) {
          const fallbackSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          fallbackSvg.setAttribute('class', 'tab-favicon tab-favicon-fallback');
          fallbackSvg.setAttribute('viewBox', '0 0 24 24');
          fallbackSvg.setAttribute('width', '16');
          fallbackSvg.setAttribute('height', '16');
          fallbackSvg.setAttribute('fill', 'none');
          fallbackSvg.setAttribute('stroke', 'currentColor');
          fallbackSvg.setAttribute('stroke-width', '1.75');
          fallbackSvg.setAttribute('stroke-linecap', 'round');
          fallbackSvg.setAttribute('stroke-linejoin', 'round');
          fallbackSvg.setAttribute('aria-hidden', 'true');
          fallbackSvg.innerHTML = `
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          `;
          target.replaceWith(fallbackSvg);
        }
      },
      true
    );

    // 7. 点击外部自动收起所有“更多...”二级下拉菜单
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dropdown-wrapper')) {
        document.querySelectorAll('.dropdown-wrapper.open').forEach((el) => {
          el.classList.remove('open');
          el.querySelector('.btn-toggle-dropdown')?.setAttribute('aria-expanded', 'false');
        });
      }
    });

    // 8. 监听右键自定义二级菜单
    this.container?.addEventListener('contextmenu', (e) => {
      const itemRow = e.target.closest('.stash-item-row');
      if (itemRow) {
        e.preventDefault();
        const card = itemRow.closest('.stash-group-card');
        const groupId = card?.dataset.groupId;
        const itemId = itemRow.dataset.itemId;
        const link = itemRow.querySelector('.tab-link');
        const url = link?.href || '';
        const title = itemRow.querySelector('.tab-title')?.textContent || '';

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

    // 9. 右键菜单内部项操作分发
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
          case 'edit-title':
            this.startInlineItemEdit(groupId, itemId);
            break;
          case 'delete':
            this.handleDeleteItemWithAnimation(groupId, itemId);
            break;
        }
      });
    }

    // 10. 关闭右键菜单监听
    document.addEventListener('click', () => this.hideContextMenu());
    window.addEventListener('scroll', () => this.hideContextMenu(), true);
    window.addEventListener('resize', () => this.hideContextMenu());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideContextMenu();
    });

    // 11. 窄屏"时间目录"悬浮按钮：点击浮出时间轴抽屉，点击遮罩或按 Esc 关闭
    this.btnTimelineFloat = document.getElementById('btnStashTimelineFloat');
    this.timelineDrawerBackdrop = document.getElementById('stashTimelineDrawerBackdrop');
    this.btnTimelineFloat?.addEventListener('click', () => this.toggleTimelineDrawer(true));
    this.timelineDrawerBackdrop?.addEventListener('click', () => this.toggleTimelineDrawer(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toggleTimelineDrawer(false);
    });
  }

  /**
   * 窄屏时间目录抽屉开关（≤1080px 时时间轴收起，经悬浮按钮唤出）
   * @param {boolean} open
   */
  toggleTimelineDrawer(open) {
    this.timelineScrollbarTrack?.classList.toggle('is-drawer-open', open);
    this.timelineDrawerBackdrop?.classList.toggle('hidden', !open);
  }

  /**
   * 分块重建后按 key 刷新筛选快照的 groupIds（loadData 与旧存储回退路径共用）：
   * 旧 Set 是选择分块时的快照，不包含本次新收纳的组，会导致新组在当前周视图中"消失"
   */
  syncTimeFilterSnapshot() {
    if (!this.activeTimeRangeFilter) return;
    const matchedChunk = this.timelineScrollbar.chunks.find((c) => c.key === this.activeTimeRangeFilter.key);
    if (matchedChunk) {
      this.activeTimeRangeFilter.groupIds = matchedChunk.groupIds;
      this.activeTimeRangeFilter.title = matchedChunk.title;
    } else {
      // 原 week 分块已不存在（如数据被清空）：回退到最新一周或全部
      const latest = this.timelineScrollbar.getCurrentChunk();
      this.activeTimeRangeFilter = latest
        ? { type: 'week', key: latest.key, title: latest.title, groupIds: latest.groupIds }
        : null;
    }
  }

  /**
   * 将任意组记录压成时间线摘要（去掉 tabs，避免后续误用全量数组）
   * @param {any} group
   * @returns {{ id: string, createdAt: number, title: string, color: string, locked: boolean, starred: boolean, archived: boolean, itemCount: number }}
   */
  static toSummary(group) {
    return {
      id: group?.id,
      createdAt: group?.createdAt,
      title: typeof group?.title === 'string' ? group.title : '',
      color: typeof group?.color === 'string' ? group.color : '',
      locked: Boolean(group?.locked),
      starred: Boolean(group?.starred),
      archived: Boolean(group?.archived),
      itemCount: Number.isFinite(group?.itemCount)
        ? group.itemCount
        : Array.isArray(group?.tabs)
          ? group.tabs.length
          : 0
    };
  }

  /**
   * 写入摘要列表；若来源仍带 tabs（旧存储回退），顺带灌进条目缓存
   * @param {any[]} summaries
   * @param {any[]} [legacyGroups]
   */
  ingestSummaries(summaries, legacyGroups = []) {
    const merged = new Map();
    for (const group of [...summaries, ...legacyGroups]) {
      if (!group?.id) continue;
      const existing = merged.get(group.id);
      if (!existing || (!Array.isArray(existing.tabs) && Array.isArray(group.tabs))) {
        merged.set(group.id, group);
      }
    }
    const rawGroups = [...merged.values()];
    this.groups = rawGroups.map((group) => StashTabComponent.toSummary(group));
    this.groupPages = new Map();
    this.measuredCardHeights = new Map();
    this.itemWindowByGroup = new Map();
    this.mountedRange = null;
    // 不清空 pinnedGroupIds：重载数据（可见性变化、同步、修订号广播）期间正在重命名 / 打开菜单的卡片必须保持原样
    for (const group of rawGroups) {
      if (!Array.isArray(group.tabs) || group.tabs.length === 0) continue;
      const slots = new Map();
      group.tabs.forEach((tab, index) => slots.set(index, tab));
      this.groupPages.set(group.id, {
        total: Number(group.itemCount) || group.tabs.length,
        slots
      });
    }
  }

  isCompactDensity() {
    return document.documentElement.dataset.displayDensity === 'compact';
  }

  async loadData() {
    const generation = ++this.loadGeneration;
    const scrollTop = this.mainColumn?.scrollTop || 0;
    const [statsRes, res] = await Promise.all([
      MessageBus.sendToBackground(ActionTypes.GET_STASH_STATS),
      MessageBus.sendToBackground(ActionTypes.GET_STASH_GROUP_SUMMARIES)
    ]);
    if (generation !== this.loadGeneration) return;
    if (statsRes.success && statsRes.data && this.badge) {
      this.badge.textContent = Number(statsRes.data.itemCount) || 0;
    }
    if (res.success && Array.isArray(res.data)) {
      this.ingestSummaries(res.data.filter((group) => group && typeof group === 'object'));
      this.timelineScrollbar.update(this.groups);
      this.syncTimeFilterSnapshot();

      // 默认只加载最新的一周分块（仅首次加载且时间轴不在"全部"状态时）
      if (!this.activeTimeRangeFilter && this.timelineScrollbar.activeChunkIndex !== -1) {
        const initialChunk = this.timelineScrollbar.getCurrentChunk();
        if (initialChunk) {
          this.activeTimeRangeFilter = {
            type: 'week',
            key: initialChunk.key,
            title: initialChunk.title,
            groupIds: initialChunk.groupIds
          };
        }
      }
      if (generation !== this.loadGeneration) return;
      this.updateBadge();
      await this.filterAndRender({ preserveScroll: true, scrollTop });
    }
  }

  updateBadge() {
    const totalTabs = this.groups.reduce((sum, g) => sum + (Number(g.itemCount) || 0), 0);
    if (this.badge) this.badge.textContent = totalTabs;
  }

  /** 按当前时间分块筛选并渲染主列表（搜索已统一由主页承载）。 */
  async filterAndRender(options = {}) {
    const inTimeRange = (groupId) =>
      !this.activeTimeRangeFilter || this.activeTimeRangeFilter.groupIds.has(groupId);

    this.filteredGroups = this.groups.filter((grp) => inTimeRange(grp.id));
    this.mountedRange = null;
    if (this.filteredGroups.length === 0) {
      this.renderEmptyState();
      return;
    }
    if (this.emptyState) this.emptyState.style.display = 'none';
    this.syncListWindow();
    if (options.preserveScroll && this.mainColumn) {
      this.mainColumn.scrollTop = Number(options.scrollTop) || 0;
      this.syncListWindow();
    }
    this.favicons.resolveVisible();
  }

  /** 渲染空状态（时间线无数据或当前时段无内容）。 */
  renderEmptyState() {
    const titleEl = this.emptyState?.querySelector('.empty-title');
    const descEl = this.emptyState?.querySelector('.empty-desc');
    if (titleEl) titleEl.textContent = '时间线目前是空的';
    if (descEl) {
      descEl.textContent = '点右上角「收纳本窗口全部标签」，或标签数量超过阈值时，闲置标签会自动出现在这里。';
    }
    if (!this.container || !this.emptyState) return;
    this.container.replaceChildren(this.emptyState);
    this.emptyState.style.display = 'flex';
    this.topSpacer = null;
    this.bottomSpacer = null;
  }

  /** 跳转主页搜索（管理中心内由宿主切换视图，独立页面则打开管理中心主页）。 */
  openHomeSearch(scope = 'stash') {
    if (this.onSearchInHome) {
      this.onSearchInHome(scope);
      return;
    }
    const hash = scope && scope !== 'all' ? `#home?scope=${encodeURIComponent(scope)}` : '#home';
    window.location.hash = hash;
  }

  /**
   * 在时间线中精准定位并高亮指定收纳组卡片
   * @param {string} groupId
   */
  async locateGroup(groupId) {
    if (!groupId) return;
    if (!this.groups || this.groups.length === 0) {
      await this.loadData();
    }
    // 若目标组不在当前时间分块内，重置时段筛选以完整展示
    if (this.activeTimeRangeFilter && !this.activeTimeRangeFilter.groupIds.has(groupId)) {
      this.activeTimeRangeFilter = null;
      await this.filterAndRender();
    }

    const highlightCard = (card) => {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const origOutline = card.style.outline;
      const origTransition = card.style.transition;
      card.style.transition = 'outline 0.2s ease, box-shadow 0.2s ease';
      card.style.outline = '2px solid var(--color-primary, #6366f1)';
      card.style.boxShadow = '0 0 16px rgba(99, 102, 241, 0.35)';
      setTimeout(() => {
        card.style.outline = origOutline;
        card.style.boxShadow = '';
        card.style.transition = origTransition;
      }, 2000);
    };

    const existingCard = this.container?.querySelector(`.stash-group-card[data-group-id="${CSS.escape(groupId)}"]`);
    if (existingCard) {
      highlightCard(existingCard);
      return;
    }

    // 虚拟窗口未挂载该卡片时，滚动至估算位置后触发挂载
    const groupIndex = this.filteredGroups.findIndex((g) => g.id === groupId);
    if (groupIndex >= 0 && this.mainColumn) {
      let estimatedTop = 0;
      for (let i = 0; i < groupIndex; i++) {
        estimatedTop += this.measuredCardHeights.get(this.filteredGroups[i].id) || 120;
      }
      this.mainColumn.scrollTop = estimatedTop;
      this.syncListWindow();
      setTimeout(() => {
        const card = this.container?.querySelector(`.stash-group-card[data-group-id="${CSS.escape(groupId)}"]`);
        if (card) highlightCard(card);
      }, 100);
    }
  }

  /**
   * 当前过滤条件下该组应展示的条目数（决定卡片高度）
   * @param {any} group
   * @returns {number}
   */
  getVisibleItemCount(group) {
    const total = Number(group.itemCount) || 0;
    if (this.expandedGroupIds.has(group.id) || total <= TABS_INITIAL_LIMIT) return total;
    return TABS_INITIAL_LIMIT;
  }

  buildGroupSizes() {
    const compact = this.isCompactDensity();
    const metrics = getDensityMetrics(compact);
    return this.filteredGroups.map((group) => {
      const measured = this.measuredCardHeights.get(group.id);
      if (Number.isFinite(measured)) return measured;
      return (
        estimateGroupCardHeight({
          itemCount: Number(group.itemCount) || 0,
          expanded: this.expandedGroupIds.has(group.id),
          compact,
          visibleItemCount: this.getVisibleItemCount(group)
        }) + metrics.gap
      );
    });
  }

  ensureSpacers() {
    if (!this.topSpacer) {
      this.topSpacer = document.createElement('div');
      this.topSpacer.className = 'stash-list-spacer stash-list-spacer-top';
      this.topSpacer.setAttribute('aria-hidden', 'true');
    }
    if (!this.bottomSpacer) {
      this.bottomSpacer = document.createElement('div');
      this.bottomSpacer.className = 'stash-list-spacer stash-list-spacer-bottom';
      this.bottomSpacer.setAttribute('aria-hidden', 'true');
    }
    return { topSpacer: this.topSpacer, bottomSpacer: this.bottomSpacer };
  }

  /**
   * 按主列滚动位置回收/挂载组卡片，并刷新已展开组的条目窗口
   */
  syncListWindow() {
    if (!this.container || !this.mainColumn) return;
    if (this.filteredGroups.length === 0) return;

    const sizes = this.buildGroupSizes();
    let range = getVisibleRange({
      scrollTop: this.mainColumn.scrollTop,
      viewportHeight: this.mainColumn.clientHeight,
      sizes,
      overscan: GROUP_OVERSCAN
    });

    for (const groupId of this.pinnedGroupIds) {
      const index = this.filteredGroups.findIndex((group) => group.id === groupId);
      if (index < 0) continue;
      range.start = Math.min(range.start, index);
      range.end = Math.max(range.end, index + 1);
    }
    const pads = computePads(sizes, range.start, range.end);
    range = { ...range, padTop: pads.padTop, padBottom: pads.padBottom };

    const sameRange =
      this.mountedRange &&
      this.mountedRange.start === range.start &&
      this.mountedRange.end === range.end &&
      this.container.querySelector('.stash-group-card');
    if (sameRange) {
      if (this.topSpacer) this.topSpacer.style.height = `${range.padTop}px`;
      if (this.bottomSpacer) this.bottomSpacer.style.height = `${range.padBottom}px`;
    } else {
      this.mountGroupWindow(range);
    }
    this.patchExpandedItemWindows();
    this.recordMeasuredHeights();
    this.prefetchVisiblePages(range);
    this.favicons.resolveVisible();
  }

  mountGroupWindow(range) {
    const { topSpacer, bottomSpacer } = this.ensureSpacers();
    topSpacer.style.height = `${range.padTop}px`;
    bottomSpacer.style.height = `${range.padBottom}px`;

    const existing = new Map();
    for (const card of this.container.querySelectorAll('.stash-group-card')) {
      existing.set(card.dataset.groupId, card);
    }

    const fragment = document.createDocumentFragment();
    fragment.appendChild(topSpacer);
    const keep = new Set();
    for (let i = range.start; i < range.end; i++) {
      const group = this.filteredGroups[i];
      if (!group) continue;
      keep.add(group.id);
      let card = existing.get(group.id);
      const pinned = this.pinnedGroupIds.has(group.id);
      // 组头（标题、星标、锁定、颜色、数量）变化或残留已取消的编辑框时整卡重建，否则只刷新条目列表
      const headerStale = card && !pinned && (
        card.dataset.headerSig !== headerSignature(group)
        || card.querySelector('.stash-group-header .inline-title-input')
      );
      if (!card || headerStale) {
        card = this.createGroupCardElement(group);
      } else if (!pinned) {
        this.refreshCardItems(card, group);
      }
      fragment.appendChild(card);
    }
    fragment.appendChild(bottomSpacer);

    this.container.replaceChildren(fragment);
    this.mountedRange = { start: range.start, end: range.end };
    if (this.emptyState) this.emptyState.style.display = 'none';
  }

  recordMeasuredHeights() {
    if (!this.container) return;
    const compact = this.isCompactDensity();
    const gap = getDensityMetrics(compact).gap;
    for (const card of this.container.querySelectorAll('.stash-group-card')) {
      const groupId = card.dataset.groupId;
      if (!groupId || this.pinnedGroupIds.has(groupId)) continue;
      const group = this.filteredGroups.find((item) => item.id === groupId);
      const expectedRows = group ? Math.min(this.getVisibleItemCount(group), TABS_INITIAL_LIMIT) : 0;
      const mountedRows = card.querySelectorAll('.stash-item-row').length;
      if (expectedRows > 0 && mountedRows === 0) continue;
      this.measuredCardHeights.set(groupId, card.offsetHeight + gap);
    }
  }

  hasFilledSlots(groupId, start, end) {
    const cache = this.groupPages.get(groupId);
    if (!cache) return false;
    for (let index = start; index < end; index++) {
      if (!cache.slots.has(index)) return false;
    }
    return true;
  }

  prefetchVisiblePages(range) {
    for (let i = range.start; i < range.end; i++) {
      const group = this.filteredGroups[i];
      if (!group) continue;
      const visibleCount = this.getVisibleItemCount(group);
      const itemWindow = this.itemWindowByGroup.get(group.id);
      const start = itemWindow?.start || 0;
      const end = Math.max(itemWindow?.end || visibleCount, Math.min(visibleCount, TABS_INITIAL_LIMIT));
      if (end <= start || this.hasFilledSlots(group.id, start, end)) continue;
      this.ensureSlots(group.id, start, end).then((result) => {
        const card = this.container?.querySelector(`.stash-group-card[data-group-id="${CSS.escape(group.id)}"]`);
        if (result.failed) {
          if (card) card.dataset.pageLoadState = 'failed';
          return;
        }
        if (card) delete card.dataset.pageLoadState;
        if (!result.changed) return;
        this.measuredCardHeights.delete(group.id);
        if (card && !this.pinnedGroupIds.has(group.id)) {
          this.refreshCardItems(card, group);
          const gap = getDensityMetrics(this.isCompactDensity()).gap;
          this.measuredCardHeights.set(group.id, card.offsetHeight + gap);
        }
        // 条目行是异步分页填充的，同步渲染路径上的图标解析执行时行尚未挂载，此处补触发
        this.favicons.resolveVisible();
      });
    }
  }

  getGroupPageCache(groupId) {
    let cache = this.groupPages.get(groupId);
    if (!cache) {
      const summary = this.groups.find((group) => group.id === groupId);
      cache = { total: Number(summary?.itemCount) || 0, slots: new Map() };
      this.groupPages.set(groupId, cache);
    }
    return cache;
  }

  async ensureSlots(groupId, start, end) {
    const prev = this.pageLoaders.get(groupId) || Promise.resolve({ changed: false, failed: false });
    const next = prev.then(() => this._ensureSlotsUnlocked(groupId, start, end));
    this.pageLoaders.set(
      groupId,
      next.then(
        () => ({ changed: false, failed: false }),
        () => ({ changed: false, failed: true })
      )
    );
    return next;
  }

  async _ensureSlotsUnlocked(groupId, start, end) {
    const cache = this.getGroupPageCache(groupId);
    const safeStart = Math.max(0, Math.floor(Number(start) || 0));
    const safeEnd = Math.max(safeStart, Math.floor(Number(end) || 0));
    let cursor = safeStart;
    let changed = false;
    let failed = false;
    while (cursor < safeEnd) {
      if (cache.slots.has(cursor)) {
        cursor += 1;
        continue;
      }
      let holeEnd = cursor + 1;
      while (holeEnd < safeEnd && !cache.slots.has(holeEnd)) holeEnd += 1;
      const limit = Math.min(500, holeEnd - cursor);
      const res = await MessageBus.sendToBackground(ActionTypes.GET_STASH_GROUP_PAGE, {
        groupId,
        offset: cursor,
        limit
      });
      if (!res?.success || !res.data) {
        failed = true;
        break;
      }
      cache.total = Number(res.data.total) || cache.total;
      const items = Array.isArray(res.data.items) ? res.data.items : [];
      items.forEach((item, index) => cache.slots.set(cursor + index, item));
      changed = changed || items.length > 0;
      if (items.length === 0) break;
      cursor += items.length;
    }
    const summary = this.groups.find((group) => group.id === groupId);
    if (summary && Number.isFinite(cache.total)) summary.itemCount = cache.total;
    return { changed, failed };
  }

  /**
   * 读取组内全部条目
   * @param {string} groupId
   * @param {{ strict?: boolean }} [options] - strict 时任一分页读取失败即抛错（删除前的撤销快照必须完整）
   */
  async fetchAllGroupItems(groupId, { strict = false } = {}) {
    const items = [];
    let offset = 0;
    while (true) {
      const res = await MessageBus.sendToBackground(ActionTypes.GET_STASH_GROUP_PAGE, {
        groupId,
        offset,
        limit: 500
      });
      if (!res?.success || !res.data) {
        if (strict) throw new Error(res?.error || '读取收纳组内容失败');
        break;
      }
      const pageItems = Array.isArray(res.data.items) ? res.data.items : [];
      items.push(...pageItems);
      const total = Number(res.data.total) || items.length;
      if (items.length >= total || pageItems.length === 0) break;
      offset += pageItems.length;
    }
    const cache = this.getGroupPageCache(groupId);
    cache.total = items.length;
    items.forEach((item, index) => cache.slots.set(index, item));
    return items;
  }

  resolveItemWindow(group, listEl) {
    const total = this.getVisibleItemCount(group);
    const compact = this.isCompactDensity();
    const rowHeight = getDensityMetrics(compact).rowHeight;
    const useVirtual = this.expandedGroupIds.has(group.id) && total > TABS_INITIAL_LIMIT;
    if (!useVirtual) {
      const window = { start: 0, end: total, padTop: 0, padBottom: 0 };
      this.itemWindowByGroup.set(group.id, window);
      return window;
    }
    const listTop = listEl && this.mainColumn
      ? listEl.getBoundingClientRect().top - this.mainColumn.getBoundingClientRect().top + this.mainColumn.scrollTop
      : 0;
    const window = getItemWindow({
      listTop,
      scrollTop: this.mainColumn?.scrollTop || 0,
      viewportHeight: this.mainColumn?.clientHeight || 0,
      itemCount: total,
      rowHeight,
      overscan: TAB_OVERSCAN
    });
    this.itemWindowByGroup.set(group.id, window);
    return window;
  }

  buildItemRowsHtml(group, window) {
    const cache = this.getGroupPageCache(group.id);
    const rows = [];
    for (let i = window.start; i < window.end; i++) {
      const tab = cache.slots.get(i);
      if (tab) rows.push(renderItemRowHtml(group.id, tab));
    }
    return rows.join('');
  }


  refreshCardItems(card, group) {
    const listEl = card.querySelector('.stash-items-list');
    if (!listEl) return;
    const window = this.resolveItemWindow(group, listEl);
    listEl.style.paddingTop = window.padTop ? `${window.padTop}px` : '';
    listEl.style.paddingBottom = window.padBottom ? `${window.padBottom}px` : '';
    listEl.classList.toggle('is-virtual', window.padTop > 0 || window.padBottom > 0);
    listEl.innerHTML = this.buildItemRowsHtml(group, window);
    card.classList.toggle('is-expanded', this.expandedGroupIds.has(group.id));

    const tabCount = Number(group.itemCount) || 0;
    const hasMoreTabs = tabCount > TABS_INITIAL_LIMIT && !this.expandedGroupIds.has(group.id);
    let moreBtn = card.querySelector('.btn-show-more-tabs');
    if (hasMoreTabs) {
      if (!moreBtn) {
        moreBtn = document.createElement('button');
        moreBtn.className = 'btn-show-more-tabs';
        moreBtn.type = 'button';
        moreBtn.dataset.id = group.id;
        card.appendChild(moreBtn);
      }
      moreBtn.textContent = `展开其余 ${tabCount - TABS_INITIAL_LIMIT} 个标签页...`;
    } else if (moreBtn) {
      moreBtn.remove();
    }
  }

  patchExpandedItemWindows() {
    for (const card of this.container?.querySelectorAll('.stash-group-card') || []) {
      const groupId = card.dataset.groupId;
      const group = this.filteredGroups.find((item) => item.id === groupId);
      if (!group || this.pinnedGroupIds.has(groupId)) continue;
      const listEl = card.querySelector('.stash-items-list');
      const previous = this.itemWindowByGroup.get(groupId);
      const next = this.resolveItemWindow(group, listEl);
      if (
        previous &&
        previous.start === next.start &&
        previous.end === next.end &&
        previous.padTop === next.padTop &&
        previous.padBottom === next.padBottom &&
        listEl?.childElementCount
      ) {
        continue;
      }
      this.refreshCardItems(card, group);
    }
  }

  /**
   * 设置时间分块加载并切换视图
   * @param {Object} node
   */
  setTimeRangeFilter(node) {
    if (!node) return;
    this.activeTimeRangeFilter = {
      type: node.type,
      key: node.key,
      title: node.title,
      groupIds: new Set(node.groupIds)
    };
    this.filterAndRender();
    if (this.mainColumn) {
      this.mainColumn.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      this.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    Toast.show(`已分块加载：${node.title}`);
  }

  /**
   * 清除时间分块筛选并恢复全量收纳
   */
  clearTimeRangeFilter() {
    this.activeTimeRangeFilter = null;
    this.filterAndRender();
    if (this.mainColumn) {
      this.mainColumn.scrollTo({ top: 0, behavior: 'smooth' });
    }
    Toast.show('已恢复全量收纳列表');
  }


  createGroupCardElement(group) {
    const card = document.createElement('div');
    card.className = `stash-group-card ${group.starred ? 'is-starred' : ''} ${group.locked ? 'is-locked' : ''} ${this.expandedGroupIds.has(group.id) ? 'is-expanded' : ''}`;
    card.dataset.groupId = group.id;
    card.dataset.headerSig = headerSignature(group);

    const itemWindow = this.resolveItemWindow(group, null);
    card.innerHTML = renderGroupCardHtml(group, {
      expanded: this.expandedGroupIds.has(group.id),
      itemWindow,
      itemsHtml: this.buildItemRowsHtml(group, itemWindow)
    });

    return card;
  }






  /**
   * 时间线卡片点击事件委托：按 CARD_CLICK_ACTIONS 顺序匹配第一个命中的按钮并分派
   * @param {MouseEvent} e
   */
  async handleContainerClick(e) {
    for (const [selector, method] of CARD_CLICK_ACTIONS) {
      const target = e.target.closest(selector);
      if (!target) continue;
      // 下拉开关只阻止冒泡（避免被 document 级"点击空白处收起"立即关闭），其余按钮阻止默认跳转
      if (selector === '.btn-toggle-dropdown') e.stopPropagation();
      else e.preventDefault();
      await this[method](target);
      return;
    }
  }

  async restoreWholeGroup(button) {
    const groupId = button.dataset.id;
    const group = this.groups.find((g) => g.id === groupId);
    button.disabled = true;
    Toast.show(`正在后台还原 ${group?.itemCount || 0} 个网页...`);
    await MessageBus.sendToBackground(ActionTypes.RESTORE_STASH_GROUP, { groupId });
    await this.loadData();
  }

  toggleGroupDropdown(button) {
    const wrapper = button.closest('.dropdown-wrapper');
    const wasOpen = wrapper.classList.contains('open');
    document.querySelectorAll('.dropdown-wrapper.open').forEach((el) => {
      el.classList.remove('open');
      el.querySelector('.btn-toggle-dropdown')?.setAttribute('aria-expanded', 'false');
    });
    const groupId = button.dataset.id;
    button.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
    if (!wasOpen) {
      wrapper.classList.add('open');
      if (groupId) this.pinnedGroupIds.add(groupId);
    } else if (groupId) {
      this.pinnedGroupIds.delete(groupId);
    }
  }

  /**
   * 删除整组（5 秒内可撤销）
   * @param {HTMLElement} button
   */
  async deleteGroupWithUndo(button) {
    const groupId = button.dataset.id;
    const targetGroup = this.groups.find((g) => g.id === groupId);
    if (!targetGroup) return;

    if (targetGroup.locked) {
      Toast.show('⚠️ 该组已锁定保护，请先解除锁定后再删除');
      return;
    }

    // 消费 deleteConfirmation 设置：开启时删除前需二次确认
    if (await this.shouldConfirmDelete()) {
      const confirmed = window.confirm(`确定删除收纳组「${targetGroup.title || groupId}」吗？（删除后 5 秒内可撤销）`);
      if (!confirmed) return;
    }

    // 撤销快照不完整时绝不删除：否则"撤销"只能恢复出半个组
    let snapshotTabs;
    try {
      snapshotTabs = await this.fetchAllGroupItems(groupId, { strict: true });
    } catch (err) {
      Toast.show(`删除已取消：${err?.message || '读取收纳组内容失败'}`);
      return;
    }
    this.recentlyDeletedGroups.set(groupId, {
      group: {
        id: targetGroup.id,
        createdAt: targetGroup.createdAt,
        title: targetGroup.title,
        color: targetGroup.color,
        locked: targetGroup.locked,
        starred: targetGroup.starred,
        archived: targetGroup.archived,
        tabs: snapshotTabs
      },
      index: this.groups.findIndex((g) => g.id === groupId)
    });
    // 缓存只保留最近 20 条，避免长时间使用后无界增长
    while (this.recentlyDeletedGroups.size > 20) {
      const oldestKey = this.recentlyDeletedGroups.keys().next().value;
      this.recentlyDeletedGroups.delete(oldestKey);
    }

    const deleteRes = await MessageBus.sendToBackground(ActionTypes.DELETE_STASH_GROUP, { groupId });
    await this.loadData();
    if (!deleteRes?.success || deleteRes.data === false) {
      this.recentlyDeletedGroups.delete(groupId);
      Toast.show(`删除失败：${deleteRes?.error || '该组可能已锁定或已被删除'}`);
      return;
    }

    Toast.show('已删除该收纳组', 5000, {
      text: '撤销',
      onClick: () => this.undoDeleteGroup(groupId)
    });
  }

  /**
   * 撤销删除：走"单组快照恢复"专用通道，仅写回被删除的这一个组，
   * 不经过全量备份管线（该管线会追加导入现有组并触发配置/规则恢复）
   * @param {string} groupId
   */
  async undoDeleteGroup(groupId) {
    const cached = this.recentlyDeletedGroups.get(groupId);
    if (!cached) return;
    const res = await MessageBus.sendToBackground(ActionTypes.RESTORE_STASH_GROUP_DATA, { group: cached.group });
    this.recentlyDeletedGroups.delete(groupId);
    await this.loadData();
    Toast.show(res?.success ? '已成功恢复该收纳组' : `恢复失败：${res?.error || '存储写入异常'}`);
  }

  /**
   * 切换组的布尔属性（星标 / 锁定）
   * @param {string} groupId
   * @param {'starred' | 'locked'} field
   */
  async toggleGroupFlag(groupId, field) {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return;
    await MessageBus.sendToBackground(ActionTypes.UPDATE_STASH_GROUP, {
      groupId,
      updates: { [field]: !group[field] }
    });
    await this.loadData();
  }

  toggleGroupStar(button) {
    return this.toggleGroupFlag(button.dataset.id, 'starred');
  }

  toggleGroupLock(button) {
    return this.toggleGroupFlag(button.dataset.id, 'locked');
  }

  renameGroupFromButton(button) {
    this.startInlineRename(button.dataset.id);
  }

  async copyGroupUrls(button) {
    const items = await this.fetchAllGroupItems(button.dataset.id);
    if (items.length === 0) return;
    await navigator.clipboard.writeText(items.map((t) => `${t.url} | ${t.title}`).join('\n'));
    Toast.show(`已复制该组全部 ${items.length} 个网页链接到剪贴板`);
  }

  async restoreSingleItem(link) {
    const { groupId, itemId } = link.dataset;
    await MessageBus.sendToBackground(ActionTypes.RESTORE_STASH_ITEM, { groupId, itemId });
    await this.loadData();
  }

  deleteItemFromButton(button) {
    this.handleDeleteItemWithAnimation(button.dataset.groupId, button.dataset.itemId);
  }

  editItemFromButton(button) {
    this.startInlineItemEdit(button.dataset.groupId, button.dataset.itemId);
  }

  /**
   * 展开超长组内的全部标签
   * @param {HTMLElement} button
   */
  expandGroupItems(button) {
    const groupId = button.dataset.id;
    const scrollTop = this.mainColumn?.scrollTop || 0;
    this.expandedGroupIds.add(groupId);
    this.measuredCardHeights.delete(groupId);
    const group = this.groups.find((item) => item.id === groupId);
    const card = button.closest('.stash-group-card');
    if (!group || !card) {
      this.syncListWindow();
      return;
    }
    this.refreshCardItems(card, group);
    this.ensureSlots(groupId, 0, Math.min(Number(group.itemCount) || 0, TABS_INITIAL_LIMIT + TAB_OVERSCAN)).then((result) => {
      if (result.changed) this.refreshCardItems(card, group);
      if (result.failed) card.dataset.pageLoadState = 'failed';
      else delete card.dataset.pageLoadState;
      this.syncListWindow();
      if (this.mainColumn) this.mainColumn.scrollTop = scrollTop;
    });
  }

  startInlineRename(groupId) {
    const card = this.container.querySelector(`.stash-group-card[data-group-id="${CSS.escape(groupId)}"]`);
    if (!card) return;

    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return;

    this.pinnedGroupIds.add(groupId);
    const titleBlock = card.querySelector('.stash-title-block');
    const oldTitle = group.title || '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-title-input';
    input.value = oldTitle;
    input.setAttribute('aria-label', '修改标签组名称');

    titleBlock.innerHTML = '';
    titleBlock.appendChild(input);
    input.focus();
    input.select();

    let isSaved = false;
    const saveNewTitle = async () => {
      if (isSaved) return;
      isSaved = true;
      const newTitle = input.value.trim();
      await MessageBus.sendToBackground(ActionTypes.UPDATE_STASH_GROUP, {
        groupId,
        updates: { title: newTitle || oldTitle }
      });
      this.pinnedGroupIds.delete(groupId);
      await this.loadData();
    };

    input.addEventListener('blur', saveNewTitle);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        saveNewTitle();
      } else if (e.key === 'Escape') {
        isSaved = true;
        this.pinnedGroupIds.delete(groupId);
        this.filterAndRender();
      }
    });
  }

  startInlineItemEdit(groupId, itemId) {
    const row = this.container.querySelector(
      `.stash-item-row[data-group-id="${CSS.escape(groupId)}"][data-item-id="${CSS.escape(itemId)}"]`
    );
    if (!row) return;
    this.pinnedGroupIds.add(groupId);
    const cached = this.getGroupPageCache(groupId);
    let tab = null;
    for (const item of cached.slots.values()) {
      if (item.id === itemId) {
        tab = item;
        break;
      }
    }
    const titleEl = row.querySelector('.tab-title');
    if (!titleEl) return;

    const oldTitle = tab?.title || titleEl.textContent || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-title-input';
    input.value = oldTitle;
    input.setAttribute('aria-label', '修改网页标题');
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let isSaved = false;
    const saveTitle = async () => {
      if (isSaved) return;
      isSaved = true;
      const newTitle = input.value.trim();
      const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_STASH_ITEM, {
        groupId,
        itemId,
        updates: { title: newTitle || oldTitle }
      });
      if (!res?.success) Toast.show(res?.error || '标题保存失败');
      await this.loadData();
    };

    input.addEventListener('blur', saveTitle);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveTitle();
      else if (e.key === 'Escape') {
        isSaved = true;
        this.pinnedGroupIds.delete(groupId);
        this.filterAndRender();
      }
    });
  }

  /**
   * 读取"删除前二次确认"设置（每次删除时实时读取，保证设置页修改后即时生效）
   * @returns {Promise<boolean>}
   */
  async shouldConfirmDelete() {
    try {
      const res = await MessageBus.sendToBackground(ActionTypes.GET_CONFIG);
      const settings = res?.data?.stashSettings || {};
      return settings.deleteConfirmation !== false;
    } catch {
      return true;
    }
  }

  handleDeleteItemWithAnimation(groupId, itemId) {
    const row = this.container.querySelector(`.stash-item-row[data-item-id="${CSS.escape(itemId)}"]`);
    if (groupId) this.pinnedGroupIds.add(groupId);
    const runDelete = async () => {
      this.pinnedGroupIds.delete(groupId);
      await MessageBus.sendToBackground(ActionTypes.DELETE_STASH_ITEM, { groupId, itemId });
      await this.loadData();
    };
    (async () => {
      if (await this.shouldConfirmDelete()) {
        if (!window.confirm('确定从收纳箱中删除此网页吗？')) return;
      }
      if (row) {
        row.classList.add('is-deleting');
        setTimeout(runDelete, 160);
      } else {
        runDelete();
      }
    })();
  }

  showContextMenu({ x, y, groupId, itemId, url, title }) {
    if (!this.contextMenu) return;
    if (groupId) this.pinnedGroupIds.add(groupId);
    this.activeContextItem = { groupId, itemId, url, title };
    this.contextMenu.classList.remove('hidden');

    const menuWidth = this.contextMenu.offsetWidth || 170;
    const menuHeight = this.contextMenu.offsetHeight || 160;
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;

    let posX = x;
    let posY = y;
    if (posX + menuWidth > winWidth) posX = winWidth - menuWidth - 10;
    if (posY + menuHeight > winHeight) posY = winHeight - menuHeight - 10;

    this.contextMenu.style.left = `${Math.max(10, posX)}px`;
    this.contextMenu.style.top = `${Math.max(10, posY)}px`;
  }

  hideContextMenu() {
    if (this.contextMenu && !this.contextMenu.classList.contains('hidden')) {
      this.contextMenu.classList.add('hidden');
      const groupId = this.activeContextItem?.groupId;
      this.activeContextItem = null;
      if (groupId && !this.container?.querySelector('.inline-title-input')) {
        this.pinnedGroupIds.delete(groupId);
      }
    }
  }
}

/**
 * 收纳箱设置组件 (StashSettingsComponent) - 管理收纳运行与展示偏好
 */
