/**
 * @file options.js
 * @description 选项与收纳管理中心视图控制器（完全对标 OneTab 并支持四级时间树索引、即地命名、5秒撤销、14项偏好设置、无感刷新与自动保存）
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
 * 收纳时间树构建器与聚合算法（年 > 月 > 周 > 日）
 */
class TimeTreeBuilder {
  /**
   * 根据自然周规则计算时间所属的周次与起止日期（周一为起始日）
   * @param {Date} date
   * @returns {{ weekNum: number, year: number, mondayStr: string, sundayStr: string, label: string }}
   */
  static getWeekInfo(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    // 周一为 0，周日为 6
    const dayOfWeek = (d.getDay() + 6) % 7;

    // 计算当周周一
    const monday = new Date(d);
    monday.setDate(d.getDate() - dayOfWeek);

    // 计算当周周日
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    // 计算 ISO-8601 周数 (基于当周周四所在年份)
    const thursday = new Date(monday);
    thursday.setDate(monday.getDate() + 3);
    const firstJan4 = new Date(thursday.getFullYear(), 0, 4);
    const firstThursdayDay = (firstJan4.getDay() + 6) % 7;
    const firstMonday = new Date(firstJan4);
    firstMonday.setDate(firstJan4.getDate() - firstThursdayDay);

    const weekNum = 1 + Math.round(((thursday.getTime() - firstMonday.getTime()) / 86400000) / 7);

    const pad = (n) => String(n).padStart(2, '0');
    const startStr = `${pad(monday.getMonth() + 1)}.${pad(monday.getDate())}`;
    const endStr = `${pad(sunday.getMonth() + 1)}.${pad(sunday.getDate())}`;

    return {
      weekNum,
      year: thursday.getFullYear(),
      mondayStr: startStr,
      sundayStr: endStr,
      label: `第 ${weekNum} 周 · ${startStr}(周一) ~ ${endStr}(周日)`
    };
  }

  /**
   * 将收纳标签组列表构建为四级时间索引树（年 > 月 > 周 > 日）
   * @param {Array<Object>} groups
   * @returns {Array<Object>} 树根节点列表（年份列表，倒序）
   */
  static buildTree(groups) {
    if (!Array.isArray(groups) || groups.length === 0) {
      return [];
    }

    const dayOfWeekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const pad = (n) => String(n).padStart(2, '0');

    // 存储年份节点的 Map: year -> { id, type, key, title, groupCount, tabCount, firstGroupId, groupIds: Set, children: Map(month) }
    const yearMap = new Map();

    for (const group of groups) {
      const timestamp = group.createdAt || Date.now();
      const date = new Date(timestamp);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      const day = date.getDate();
      const tabCount = group.tabs?.length || 0;

      const weekInfo = this.getWeekInfo(date);
      const weekKey = `${weekInfo.year}-W${pad(weekInfo.weekNum)}`;
      const dayKey = `${year}-${pad(month)}-${pad(day)}`;
      const dayName = dayOfWeekNames[date.getDay()];

      // 1. 年节点
      let yearNode = yearMap.get(year);
      if (!yearNode) {
        yearNode = {
          id: `node_year_${year}`,
          type: 'year',
          key: String(year),
          title: `${year} 年`,
          groupCount: 0,
          tabCount: 0,
          firstGroupId: group.id,
          groupIds: new Set(),
          months: new Map()
        };
        yearMap.set(year, yearNode);
      }
      yearNode.groupCount += 1;
      yearNode.tabCount += tabCount;
      yearNode.groupIds.add(group.id);

      // 2. 月节点
      let monthNode = yearNode.months.get(month);
      if (!monthNode) {
        monthNode = {
          id: `node_month_${year}_${pad(month)}`,
          type: 'month',
          key: `${year}-${pad(month)}`,
          title: `${pad(month)} 月`,
          groupCount: 0,
          tabCount: 0,
          firstGroupId: group.id,
          groupIds: new Set(),
          weeks: new Map()
        };
        yearNode.months.set(month, monthNode);
      }
      monthNode.groupCount += 1;
      monthNode.tabCount += tabCount;
      monthNode.groupIds.add(group.id);

      // 3. 周节点
      let weekNode = monthNode.weeks.get(weekKey);
      if (!weekNode) {
        weekNode = {
          id: `node_week_${weekKey}`,
          type: 'week',
          key: weekKey,
          title: weekInfo.label,
          groupCount: 0,
          tabCount: 0,
          firstGroupId: group.id,
          groupIds: new Set(),
          days: new Map()
        };
        monthNode.weeks.set(weekKey, weekNode);
      }
      weekNode.groupCount += 1;
      weekNode.tabCount += tabCount;
      weekNode.groupIds.add(group.id);

      // 4. 日节点
      let dayNode = weekNode.days.get(dayKey);
      if (!dayNode) {
        dayNode = {
          id: `node_day_${dayKey}`,
          type: 'day',
          key: dayKey,
          title: `${pad(month)}-${pad(day)} ${dayName}`,
          groupCount: 0,
          tabCount: 0,
          firstGroupId: group.id,
          groupIds: new Set()
        };
        weekNode.days.set(dayKey, dayNode);
      }
      dayNode.groupCount += 1;
      dayNode.tabCount += tabCount;
      dayNode.groupIds.add(group.id);
    }

    // 转换为树状数组并按时间倒序排序
    const yearList = Array.from(yearMap.values()).sort((a, b) => Number(b.key) - Number(a.key));
    for (const y of yearList) {
      y.children = Array.from(y.months.values()).sort((a, b) => {
        const monthA = parseInt(a.key.split('-')[1], 10);
        const monthB = parseInt(b.key.split('-')[1], 10);
        return monthB - monthA;
      });
      delete y.months;

      for (const m of y.children) {
        m.children = Array.from(m.weeks.values()).sort((a, b) => {
          const numA = parseInt(a.key.split('-W')[1], 10);
          const numB = parseInt(b.key.split('-W')[1], 10);
          return numB - numA;
        });
        delete m.weeks;

        for (const w of m.children) {
          w.children = Array.from(w.days.values()).sort((a, b) => b.key.localeCompare(a.key));
          delete w.days;
        }
      }
    }

    return yearList;
  }
}

/**
 * 标签收纳箱右侧时间导航目录组件
 */
class TimeNavigatorComponent {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.container - 时间树容器 DOM
   * @param {HTMLElement} options.aside - 右侧 Aside DOM
   * @param {HTMLElement} options.floatBtn - 窄屏悬浮按钮
   * @param {HTMLElement} options.backdrop - 抽屉遮罩背景
   * @param {HTMLElement} options.starredNode - 星标节点 DOM
   * @param {HTMLElement} options.starredCount - 星标计数 DOM
   * @param {HTMLElement} options.btnToggleAll - 全部展开/折叠按钮
   * @param {HTMLElement} options.btnCloseDrawer - 抽屉关闭按钮
   * @param {Function} options.onNavigate - 点击时间节点导航回调 (groupId, node) => void
   * @param {Function} options.onFilter - 点击区间筛选回调 (node) => void
   * @param {Function} options.onNavigateStarred - 点击星标入口回调 () => void
   */
  constructor(options) {
    this.container = options.container;
    this.aside = options.aside;
    this.floatBtn = options.floatBtn;
    this.backdrop = options.backdrop;
    this.starredNode = options.starredNode;
    this.starredCount = options.starredCount;
    this.btnToggleAll = options.btnToggleAll;
    this.btnCloseDrawer = options.btnCloseDrawer;
    this.onNavigate = options.onNavigate;
    this.onFilter = options.onFilter;
    this.onNavigateStarred = options.onNavigateStarred;

    this.expandedNodeIds = new Set();
    this.allExpanded = false;
    this.rawGroups = [];
    this.activeFilter = null;

    this.init();
  }

  init() {
    this.bindEvents();
  }

  bindEvents() {
    // 1. 全部展开/折叠切换
    this.btnToggleAll?.addEventListener('click', () => {
      this.allExpanded = !this.allExpanded;
      if (this.allExpanded) {
        this.expandAllNodes();
      } else {
        this.expandedNodeIds.clear();
      }
      this.renderTree();
    });

    // 2. 星标置顶入口点击
    this.starredNode?.addEventListener('click', () => {
      this.onNavigateStarred?.();
      this.closeDrawer();
    });

    // 3. 窄屏抽屉打开/关闭
    this.floatBtn?.addEventListener('click', () => this.openDrawer());
    this.btnCloseDrawer?.addEventListener('click', () => this.closeDrawer());
    this.backdrop?.addEventListener('click', () => this.closeDrawer());

    // 4. 事件委托处理树节点点击（展开折叠、定位、筛选）
    this.container?.addEventListener('click', (e) => {
      const filterBtn = e.target.closest('.tree-filter-btn');
      if (filterBtn) {
        e.stopPropagation();
        const nodeId = filterBtn.dataset.nodeId;
        const node = this.findNodeById(nodeId);
        if (node) {
          this.onFilter?.(node);
          this.closeDrawer();
        }
        return;
      }

      const row = e.target.closest('.tree-node-row');
      if (row) {
        const nodeId = row.dataset.nodeId;
        const node = this.findNodeById(nodeId);
        if (!node) return;

        // 若点击的是箭头区域或具有子节点，切换展开/折叠状态
        const hasChildren = Array.isArray(node.children) && node.children.length > 0;
        if (hasChildren) {
          if (this.expandedNodeIds.has(node.id)) {
            this.expandedNodeIds.delete(node.id);
          } else {
            this.expandedNodeIds.add(node.id);
          }
          this.renderTree();
        }

        // 导航至该节点对应首个卡片
        if (node.firstGroupId) {
          this.onNavigate?.(node.firstGroupId, node);
          this.closeDrawer();
        }
      }
    });
  }

  openDrawer() {
    this.aside?.classList.add('drawer-open');
    this.backdrop?.classList.remove('hidden');
  }

  closeDrawer() {
    this.aside?.classList.remove('drawer-open');
    this.backdrop?.classList.add('hidden');
  }

  /**
   * 刷新时间树数据
   * @param {Array<Object>} allGroups - 全量收纳组数据
   * @param {Array<Object>} filteredGroups - 当前筛选后的组数据
   * @param {string} [searchQuery=''] - 搜索关键字
   * @param {Object} [activeFilter=null] - 当前时间区间过滤器
   */
  update(allGroups, filteredGroups, searchQuery = '', activeFilter = null) {
    this.rawGroups = allGroups || [];
    this.activeFilter = activeFilter;
    this.treeData = TimeTreeBuilder.buildTree(this.rawGroups);

    // 1. 更新星标置顶入口状态
    const starredGroups = this.rawGroups.filter((g) => g.starred);
    if (this.starredNode && this.starredCount) {
      if (starredGroups.length > 0) {
        this.starredNode.classList.remove('hidden');
        this.starredCount.textContent = starredGroups.length;
      } else {
        this.starredNode.classList.add('hidden');
      }
    }

    // 2. 若初次构建，默认自动展开最近的第 1 年及第 1 月
    if (this.expandedNodeIds.size === 0 && this.treeData.length > 0) {
      const topYear = this.treeData[0];
      this.expandedNodeIds.add(topYear.id);
      if (topYear.children && topYear.children.length > 0) {
        this.expandedNodeIds.add(topYear.children[0].id);
      }
    }

    this.renderTree();
  }

  expandAllNodes() {
    const traverse = (nodes) => {
      for (const n of nodes) {
        if (n.children && n.children.length > 0) {
          this.expandedNodeIds.add(n.id);
          traverse(n.children);
        }
      }
    };
    traverse(this.treeData || []);
  }

  findNodeById(id) {
    const traverse = (nodes) => {
      for (const n of nodes) {
        if (n.id === id) return n;
        if (n.children) {
          const found = traverse(n.children);
          if (found) return found;
        }
      }
      return null;
    };
    return traverse(this.treeData || []);
  }

  renderTree() {
    if (!this.container) return;

    if (!this.treeData || this.treeData.length === 0) {
      this.container.innerHTML = `
        <div class="tree-empty-hint">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span>暂无收纳历史时间记录</span>
        </div>
      `;
      return;
    }

    const renderNodeHtml = (node, level = 0) => {
      const hasChildren = Array.isArray(node.children) && node.children.length > 0;
      const isExpanded = this.expandedNodeIds.has(node.id);
      const isActive = this.activeFilter && this.activeFilter.key === node.key;

      let arrowHtml = '';
      if (hasChildren) {
        arrowHtml = `
          <svg class="tree-arrow ${isExpanded ? 'expanded' : ''}" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        `;
      } else {
        arrowHtml = `<span class="tree-arrow empty"></span>`;
      }

      let childrenHtml = '';
      if (hasChildren) {
        childrenHtml = `
          <div class="tree-node-children ${isExpanded ? '' : 'collapsed'}" role="group">
            ${node.children.map((child) => renderNodeHtml(child, level + 1)).join('')}
          </div>
        `;
      }

      return `
        <div class="tree-node tree-level-${level}" role="treeitem" aria-expanded="${hasChildren ? isExpanded : 'undefined'}">
          <div class="tree-node-row ${isActive ? 'is-active' : ''}" data-node-id="${node.id}" title="${node.title} · 共 ${node.groupCount} 组 (${node.tabCount} 个标签)">
            <div class="tree-node-main">
              ${arrowHtml}
              <span class="tree-node-title">${node.title}</span>
            </div>
            <div class="tree-node-actions">
              <button class="tree-filter-btn" data-node-id="${node.id}" title="仅查看此时间段 (${node.title})" type="button" aria-label="仅筛选查看此时间段">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                </svg>
              </button>
              <span class="tree-badge">${node.groupCount}组</span>
            </div>
          </div>
          ${childrenHtml}
        </div>
      `;
    };

    this.container.innerHTML = this.treeData.map((node) => renderNodeHtml(node, 0)).join('');
  }
}

/**
 * 标签收纳箱主组件 (StashTabComponent)
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
    this.activeTimeRangeFilter = null;

    this.container = document.getElementById('stashGroupsContainer');
    this.mainColumn = document.querySelector('.stash-main-column');
    this.emptyState = document.getElementById('stashEmptyState');
    this.badge = document.getElementById('stashCountBadge');
    this.searchInput = document.getElementById('stashSearchInput');
    this.btnSearchClear = document.getElementById('btnStashSearchClear');
    this.btnStashNow = document.getElementById('btnStashNowFromOptions');
    this.sentinel = document.getElementById('stashScrollSentinel');
    this.loadingIndicator = document.getElementById('stashLoadingIndicator');
    this.contextMenu = document.getElementById('stashContextMenu');
    this.activeContextItem = null;

    // 时间导航目录与筛选相关 DOM
    this.filterBanner = document.getElementById('stashTimeFilterBanner');
    this.filterText = document.getElementById('stashTimeFilterText');
    this.btnClearTimeFilter = document.getElementById('btnStashClearTimeFilter');
    this.timelineAside = document.getElementById('stashTimelineAside');
    this.timelineTreeContainer = document.getElementById('stashTimeTree');
    this.timelineFloatBtn = document.getElementById('btnStashTimelineFloat');
    this.timelineDrawerBackdrop = document.getElementById('stashTimelineDrawerBackdrop');
    this.timelineStarredNode = document.getElementById('timelineStarredNode');
    this.timelineStarredCount = document.getElementById('timelineStarredCount');
    this.btnToggleAllTimeTree = document.getElementById('btnToggleAllTimeTree');
    this.btnCloseTimelineDrawer = document.getElementById('btnCloseTimelineDrawer');

    // 实例化时间目录导航子组件
    this.timeNavigator = new TimeNavigatorComponent({
      container: this.timelineTreeContainer,
      aside: this.timelineAside,
      floatBtn: this.timelineFloatBtn,
      backdrop: this.timelineDrawerBackdrop,
      starredNode: this.timelineStarredNode,
      starredCount: this.timelineStarredCount,
      btnToggleAll: this.btnToggleAllTimeTree,
      btnCloseDrawer: this.btnCloseTimelineDrawer,
      onNavigate: (groupId, node) => this.scrollToGroup(groupId),
      onFilter: (node) => this.setTimeRangeFilter(node),
      onNavigateStarred: () => this.scrollToStarred()
    });

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
      const scrollRoot = this.mainColumn || document.querySelector('.stash-main-column');
      this.observer = new IntersectionObserver(
        (entries) => {
          if (entries[0] && entries[0].isIntersecting) {
            this.renderNextBatch();
          }
        },
        { root: scrollRoot || null, rootMargin: '300px', threshold: 0.01 }
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
        this.mainColumn?.scrollTo({ top: 0, behavior: 'instant' });
      }, 200);
    });

    // 清空搜索
    this.btnSearchClear?.addEventListener('click', () => {
      this.searchInput.value = '';
      this.btnSearchClear.classList.add('hidden');
      this.filterAndRender();
      this.searchInput.focus();
    });

    // 2. 立即全量收纳全部窗口
    this.btnStashNow?.addEventListener('click', async () => {
      this.btnStashNow.disabled = true;
      Toast.show('正在收纳全部窗口标签页...');
      const res = await MessageBus.sendToBackground(ActionTypes.EXECUTE_STASH, { forceAll: true });
      if (res.success && res.data) {
        const { stashedCount } = res.data;
        if (stashedCount > 0) {
          Toast.show(`已全量收纳 ${stashedCount} 个标签页`);
        } else {
          Toast.show('没有可收纳的闲置网页');
        }
        await this.loadData();
      } else {
        Toast.show(res.error || '收纳失败');
      }
      this.btnStashNow.disabled = false;
    });

    // 3. 清除时间区间筛选按钮
    this.btnClearTimeFilter?.addEventListener('click', () => {
      this.clearTimeRangeFilter();
    });

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

    // 6. 图片加载失败静默隐藏回退
    this.container?.addEventListener(
      'error',
      (e) => {
        if (e.target && e.target.classList?.contains('tab-favicon')) {
          e.target.style.display = 'none';
        }
      },
      true
    );

    // 7. 点击外部自动收起所有“更多...”二级下拉菜单
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dropdown-wrapper')) {
        document.querySelectorAll('.dropdown-wrapper.open').forEach((el) => {
          el.classList.remove('open');
        });
      }
    });

    // 8. 监听右键自定义二级菜单
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

    // 1. 根据搜索条件和时间区间共同过滤
    this.filteredGroups = this.groups
      .filter((grp) => {
        if (this.activeTimeRangeFilter && !this.activeTimeRangeFilter.groupIds.has(grp.id)) {
          return false;
        }
        return true;
      })
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

    // 2. 更新时间区间提示横幅
    if (this.activeTimeRangeFilter) {
      const totalTabs = this.filteredGroups.reduce((sum, g) => sum + (g.tabs?.length || 0), 0);
      if (this.filterText) {
        this.filterText.textContent = `当前仅查看：${this.activeTimeRangeFilter.title}（共 ${this.filteredGroups.length} 组 · ${totalTabs} 个标签页）`;
      }
      this.filterBanner?.classList.remove('hidden');
    } else {
      this.filterBanner?.classList.add('hidden');
    }

    // 3. 渲染主列表内容
    this.container.innerHTML = '';
    this.renderedGroupCount = 0;

    if (this.filteredGroups.length === 0) {
      this.container.appendChild(this.emptyState);
      this.emptyState.style.display = 'flex';
      if (this.loadingIndicator) this.loadingIndicator.classList.add('hidden');
    } else {
      this.emptyState.style.display = 'none';
      this.renderNextBatch();
    }

    // 4. 同步更新右侧时间目录导航树
    this.timeNavigator?.update(this.groups, this.filteredGroups, query, this.activeTimeRangeFilter);
  }

  /**
   * 平滑滚动并高亮定位至指定收纳组卡片（自动按需加载未渲染批次）
   * @param {string} groupId
   */
  scrollToGroup(groupId) {
    if (!groupId) return;

    // 若当前处于某个不包含该组的时间区间过滤中，自动重置筛选以保证目标可见
    if (this.activeTimeRangeFilter && !this.activeTimeRangeFilter.groupIds.has(groupId)) {
      this.activeTimeRangeFilter = null;
      this.filterAndRender();
    }

    const groupIndex = this.filteredGroups.findIndex((g) => g.id === groupId);
    if (groupIndex === -1) return;

    // 若目标卡片由于无限滚动尚未挂载到 DOM，连续批量渲染至目标卡片所在位置
    while (this.renderedGroupCount <= groupIndex && this.renderedGroupCount < this.filteredGroups.length) {
      this.renderNextBatch();
    }

    // 延时等待 DOM 绘制完毕后执行平滑居中滚动与 1.8s 呼吸高亮
    setTimeout(() => {
      const card = this.container.querySelector(`.stash-group-card[data-group-id="${CSS.escape(groupId)}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('highlight-pulse');
        void card.offsetWidth;
        card.classList.add('highlight-pulse');
        setTimeout(() => {
          card.classList.remove('highlight-pulse');
        }, 1900);
      }
    }, 60);
  }

  /**
   * 一键定位至置顶星标组
   */
  scrollToStarred() {
    const firstStarred = this.groups.find((g) => g.starred);
    if (firstStarred) {
      this.scrollToGroup(firstStarred.id);
    }
  }

  /**
   * 设置时间区间筛选并切换视图
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
    Toast.show(`已过滤显示：${node.title}`);
  }

  /**
   * 清除时间区间筛选并恢复全量视图
   */
  clearTimeRangeFilter() {
    this.activeTimeRangeFilter = null;
    this.filterAndRender();
    if (this.mainColumn) {
      this.mainColumn.scrollTo({ top: 0, behavior: 'smooth' });
    }
    Toast.show('已恢复全量收纳列表');
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

    const fragment = document.createDocumentFragment();
    for (const group of nextBatch) {
      const cardEl = this.createGroupCardElement(group);
      fragment.appendChild(cardEl);
    }

    this.container.appendChild(fragment);
    this.renderedGroupCount += nextBatch.length;

    if (this.renderedGroupCount < this.filteredGroups.length) {
      if (this.loadingIndicator) this.loadingIndicator.classList.remove('hidden');
    } else {
      if (this.loadingIndicator) this.loadingIndicator.classList.add('hidden');
    }
  }

  createGroupCardElement(group) {
    const card = document.createElement('div');
    card.className = `stash-group-card ${group.starred ? 'is-starred' : ''} ${group.locked ? 'is-locked' : ''}`;
    card.dataset.groupId = group.id;

    const createdAt = group.createdAt || Date.now();
    const dateObj = new Date(createdAt);
    const dateStr = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(dateObj);

    const timeAgo = this.formatTimeAgo(createdAt);
    const tabCount = group.tabs ? group.tabs.length : 0;
    const isExpanded = this.expandedGroupIds.has(group.id);
    const visibleTabs = (group.tabs && !isExpanded && tabCount > this.TABS_INITIAL_LIMIT)
      ? group.tabs.slice(0, this.TABS_INITIAL_LIMIT)
      : (group.tabs || []);
    const hasMoreTabs = tabCount > this.TABS_INITIAL_LIMIT && !isExpanded;

    const displayGroupName = group.title || `${tabCount} 个标签页`;
    const safeGroupId = this.escapeHTML(group.id);

    let itemsHtml = '';
    for (const tab of visibleTabs) {
      const safeTabId = this.escapeHTML(tab.id);
      let faviconSrc = tab.favIconUrl;
      if (!faviconSrc && tab.url) {
        try {
          const domain = new URL(tab.url).hostname;
          if (domain) faviconSrc = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
        } catch {}
      }

      itemsHtml += `
        <li class="stash-item-row" data-group-id="${safeGroupId}" data-item-id="${safeTabId}">
          <div class="stash-item-main">
            ${faviconSrc ? `
              <img src="${this.escapeHTML(faviconSrc)}" class="tab-favicon" alt="" loading="lazy" decoding="async" />
            ` : `
              <svg class="tab-favicon tab-favicon-fallback" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
              </svg>
            `}
            <a href="${this.escapeHTML(tab.url)}" class="tab-link btn-restore-item-link" data-group-id="${safeGroupId}" data-item-id="${safeTabId}" title="${this.escapeHTML(tab.title || tab.url)}&#10;${this.escapeHTML(tab.url)}">
              ${this.escapeHTML(tab.title || tab.url)}
            </a>
          </div>
          <div class="tab-item-actions">
            <button class="btn-icon-danger btn-delete-item" data-group-id="${safeGroupId}" data-item-id="${safeTabId}" title="删除此网页" type="button" aria-label="删除此网页">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </li>
      `;
    }

    card.innerHTML = `
      <div class="stash-group-header">
        <div class="stash-header-left">
          <div class="stash-title-block" title="双击重命名标签组">
            <svg class="group-bullet-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="5"></circle>
            </svg>
            ${group.starred ? `
              <svg class="star-icon-svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none" aria-hidden="true">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
              </svg>
            ` : ''}
            ${group.locked ? `
              <svg class="lock-icon-svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            ` : ''}
            <h3 class="title-text">${this.escapeHTML(displayGroupName)}</h3>
            <svg class="edit-hint-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
            </svg>
          </div>
        </div>

        <div class="stash-header-right">
          <div class="stash-time-row" title="收纳时间：${dateStr}">
            <span class="stash-time-text">${dateStr} · ${timeAgo}</span>
            <svg class="time-dropdown-caret" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </div>

          <div class="stash-actions-row">
            <button class="stash-action-link btn-restore-all" data-id="${safeGroupId}" type="button">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
              <span>全部还原</span>
            </button>

            <div class="dropdown-wrapper">
              <button class="stash-action-link btn-toggle-dropdown" data-id="${safeGroupId}" type="button">
                <span>更多...</span>
              </button>
              <div class="dropdown-menu">
                <button class="dropdown-item btn-delete-group" data-id="${safeGroupId}" type="button">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                  <span>删除此组</span>
                </button>
                <button class="dropdown-item btn-toggle-star" data-id="${safeGroupId}" type="button">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="${group.starred ? '#fbbc04' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                  </svg>
                  <span>${group.starred ? '取消星标' : '星标此组'}</span>
                </button>
                <button class="dropdown-item btn-toggle-lock" data-id="${safeGroupId}" type="button">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                  </svg>
                  <span>${group.locked ? '解除锁定' : '锁定此组'}</span>
                </button>
                <button class="dropdown-item btn-rename-group" data-id="${safeGroupId}" type="button">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                  </svg>
                  <span>命名此组</span>
                </button>
                <div class="dropdown-divider"></div>
                <button class="dropdown-item btn-copy-group-urls" data-id="${safeGroupId}" type="button">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
                  </svg>
                  <span>复制全部链接</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ul class="stash-items-list">
        ${itemsHtml}
      </ul>

      ${hasMoreTabs ? `
        <button class="btn-show-more-tabs" data-id="${safeGroupId}" type="button">
          展开其余 ${tabCount - this.TABS_INITIAL_LIMIT} 个标签页...
        </button>
      ` : ''}
    `;

    return card;
  }

  formatTimeAgo(timestamp) {
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return '刚刚';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
    if (diffSec < 604800) return `${Math.floor(diffSec / 86400)} 天前`;
    return `${Math.floor(diffSec / 604800)} 周前`;
  }

  escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async handleContainerClick(e) {
    // 1. 全部还原组
    const btnRestoreAll = e.target.closest('.btn-restore-all');
    if (btnRestoreAll) {
      e.preventDefault();
      const groupId = btnRestoreAll.dataset.id;
      const group = this.groups.find((g) => g.id === groupId);
      btnRestoreAll.disabled = true;
      Toast.show(`正在后台还原 ${group?.tabs?.length || 0} 个网页...`);
      await MessageBus.sendToBackground(ActionTypes.RESTORE_STASH_GROUP, { groupId });
      await this.loadData();
      return;
    }

    // 2. 展开/折叠更多下拉菜单
    const btnToggleDropdown = e.target.closest('.btn-toggle-dropdown');
    if (btnToggleDropdown) {
      e.stopPropagation();
      const wrapper = btnToggleDropdown.closest('.dropdown-wrapper');
      const wasOpen = wrapper.classList.contains('open');
      document.querySelectorAll('.dropdown-wrapper.open').forEach((el) => el.classList.remove('open'));
      if (!wasOpen) wrapper.classList.add('open');
      return;
    }

    // 3. 删除整组（支持 5 秒极速撤销机制）
    const btnDeleteGroup = e.target.closest('.btn-delete-group');
    if (btnDeleteGroup) {
      e.preventDefault();
      const groupId = btnDeleteGroup.dataset.id;
      const targetGroup = this.groups.find((g) => g.id === groupId);
      if (!targetGroup) return;

      if (targetGroup.locked) {
        Toast.show('⚠️ 该组已锁定保护，请先解除锁定后再删除');
        return;
      }

      this.recentlyDeletedGroups.set(groupId, {
        group: JSON.parse(JSON.stringify(targetGroup)),
        index: this.groups.findIndex((g) => g.id === groupId)
      });

      await MessageBus.sendToBackground(ActionTypes.DELETE_STASH_GROUP, { groupId });
      await this.loadData();

      Toast.show('已删除该收纳组', 5000, {
        text: '撤销',
        onClick: async () => {
          const cached = this.recentlyDeletedGroups.get(groupId);
          if (cached) {
            await MessageBus.sendToBackground(ActionTypes.RESTORE_BACKUP_DATA, {
              backupData: {
                version: 1,
                groups: [cached.group, ...this.groups]
              }
            });
            this.recentlyDeletedGroups.delete(groupId);
            await this.loadData();
            Toast.show('已成功恢复该收纳组');
          }
        }
      });
      return;
    }

    // 4. 切换星标
    const btnToggleStar = e.target.closest('.btn-toggle-star');
    if (btnToggleStar) {
      e.preventDefault();
      const groupId = btnToggleStar.dataset.id;
      const group = this.groups.find((g) => g.id === groupId);
      if (group) {
        await MessageBus.sendToBackground(ActionTypes.UPDATE_STASH_GROUP, {
          groupId,
          updates: { starred: !group.starred }
        });
        await this.loadData();
      }
      return;
    }

    // 5. 切换锁定
    const btnToggleLock = e.target.closest('.btn-toggle-lock');
    if (btnToggleLock) {
      e.preventDefault();
      const groupId = btnToggleLock.dataset.id;
      const group = this.groups.find((g) => g.id === groupId);
      if (group) {
        await MessageBus.sendToBackground(ActionTypes.UPDATE_STASH_GROUP, {
          groupId,
          updates: { locked: !group.locked }
        });
        await this.loadData();
      }
      return;
    }

    // 6. 重命名组
    const btnRenameGroup = e.target.closest('.btn-rename-group');
    if (btnRenameGroup) {
      e.preventDefault();
      const groupId = btnRenameGroup.dataset.id;
      this.startInlineRename(groupId);
      return;
    }

    // 7. 复制组内所有链接
    const btnCopyUrls = e.target.closest('.btn-copy-group-urls');
    if (btnCopyUrls) {
      e.preventDefault();
      const groupId = btnCopyUrls.dataset.id;
      const group = this.groups.find((g) => g.id === groupId);
      if (group && group.tabs) {
        const text = group.tabs.map((t) => `${t.url} | ${t.title}`).join('\n');
        await navigator.clipboard.writeText(text);
        Toast.show(`已复制该组全部 ${group.tabs.length} 个网页链接到剪贴板`);
      }
      return;
    }

    // 8. 恢复单个标签
    const linkRestoreItem = e.target.closest('.btn-restore-item-link');
    if (linkRestoreItem) {
      e.preventDefault();
      const { groupId, itemId } = linkRestoreItem.dataset;
      await MessageBus.sendToBackground(ActionTypes.RESTORE_STASH_ITEM, { groupId, itemId });
      await this.loadData();
      return;
    }

    // 9. 删除单个标签项
    const btnDeleteItem = e.target.closest('.btn-delete-item');
    if (btnDeleteItem) {
      e.preventDefault();
      const { groupId, itemId } = btnDeleteItem.dataset;
      this.handleDeleteItemWithAnimation(groupId, itemId);
      return;
    }

    // 10. 展开超长组内所有标签
    const btnShowMore = e.target.closest('.btn-show-more-tabs');
    if (btnShowMore) {
      e.preventDefault();
      const groupId = btnShowMore.dataset.id;
      this.expandedGroupIds.add(groupId);
      this.filterAndRender();
      return;
    }
  }

  startInlineRename(groupId) {
    const card = this.container.querySelector(`.stash-group-card[data-group-id="${CSS.escape(groupId)}"]`);
    if (!card) return;

    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return;

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
      await this.loadData();
    };

    input.addEventListener('blur', saveNewTitle);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        saveNewTitle();
      } else if (e.key === 'Escape') {
        isSaved = true;
        this.filterAndRender();
      }
    });
  }

  handleDeleteItemWithAnimation(groupId, itemId) {
    const row = this.container.querySelector(`.stash-item-row[data-item-id="${CSS.escape(itemId)}"]`);
    if (row) {
      row.classList.add('is-deleting');
      setTimeout(async () => {
        await MessageBus.sendToBackground(ActionTypes.DELETE_STASH_ITEM, { groupId, itemId });
        await this.loadData();
      }, 160);
    } else {
      MessageBus.sendToBackground(ActionTypes.DELETE_STASH_ITEM, { groupId, itemId }).then(() => this.loadData());
    }
  }

  showContextMenu({ x, y, groupId, itemId, url, title }) {
    if (!this.contextMenu) return;
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
      this.activeContextItem = null;
    }
  }
}

/**
 * 收纳箱设置组件 (StashSettingsComponent) - 管理 14 项收纳运行与展示偏好
 */
class StashSettingsComponent {
  constructor() {
    this.dom = {
      selectRestoreBehavior: document.getElementById('selectRestoreBehavior'),
      selectRestorePosition: document.getElementById('selectRestorePosition'),
      chkAllowDuplicates: document.getElementById('chkAllowDuplicates'),
      selectExistingTabTitle: document.getElementById('selectExistingTabTitle'),
      chkAutoOpenStashTab: document.getElementById('chkAutoOpenStashTab'),
      chkPinnedTabGuard: document.getElementById('chkPinnedTabGuard'),
      chkDeleteConfirmation: document.getElementById('chkDeleteConfirmation'),
      chkShowTabCountBadge: document.getElementById('chkShowTabCountBadge'),
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
    if (this.dom.chkShowTabCountBadge) {
      this.dom.chkShowTabCountBadge.checked = settings.showTabCountBadge !== false;
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
      this.dom.chkShowTabCountBadge,
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
        showTabCountBadge: Boolean(this.dom.chkShowTabCountBadge?.checked),
        displayDensity: this.dom.selectDisplayDensity?.value || 'comfortable',
        autoBackupEnabled: Boolean(this.dom.chkAutoBackupEnabled?.checked),
        backupRetentionDays: parseInt(this.dom.selectBackupRetentionDays?.value || '30', 10)
      };

      const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
        stashSettings
      });

      if (res.success) {
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
class RulesConfigComponent {
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
      autoSaveIndicator: document.getElementById('rulesAutoSaveIndicator')
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
    if (this.dom.inputRecent) this.dom.inputRecent.value = config.recentActiveThresholdMinutes || 5;
    if (this.dom.chkAutoStash) this.dom.chkAutoStash.checked = Boolean(config.autoStashOnThreshold);
    if (this.dom.inputCountdown) this.dom.inputCountdown.value = config.autoStashCountdownSeconds || 15;
    if (this.dom.chkAutoNotify) this.dom.chkAutoNotify.checked = Boolean(config.notifyOnThreshold);

    const rules = config.rulesEnabled || {};
    if (this.dom.chkAudible) this.dom.chkAudible.checked = rules.audible !== false;
    if (this.dom.chkFormGuard) this.dom.chkFormGuard.checked = rules.formGuard !== false;
    if (this.dom.chkRecentActive) this.dom.chkRecentActive.checked = rules.recentActive !== false;
    if (this.dom.chkHighFrequency) this.dom.chkHighFrequency.checked = rules.frequency !== false;
    if (this.dom.chkPinned) this.dom.chkPinned.checked = rules.pinned !== false;
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
      this.dom.chkPinned
    ];

    inputs.forEach((el) => {
      if (!el) return;
      el.addEventListener('change', () => this.saveConfig());
      if (el.type === 'number') {
        el.addEventListener('input', () => this.saveConfig());
      }
    });
  }

  async saveConfig() {
    clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(async () => {
      const tabThreshold = parseInt(this.dom.inputThreshold?.value, 10) || 15;
      const recentActiveThresholdMinutes = parseInt(this.dom.inputRecent?.value, 10) || 5;
      const autoStashOnThreshold = Boolean(this.dom.chkAutoStash?.checked);
      const autoStashCountdownSeconds = parseInt(this.dom.inputCountdown?.value, 10) || 15;
      const notifyOnThreshold = Boolean(this.dom.chkAutoNotify?.checked);

      const rulesEnabled = {
        audible: Boolean(this.dom.chkAudible?.checked),
        formGuard: Boolean(this.dom.chkFormGuard?.checked),
        recentActive: Boolean(this.dom.chkRecentActive?.checked),
        frequency: Boolean(this.dom.chkHighFrequency?.checked),
        pinned: Boolean(this.dom.chkPinned?.checked)
      };

      const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
        tabThreshold,
        recentActiveThresholdMinutes,
        autoStashOnThreshold,
        autoStashCountdownSeconds,
        notifyOnThreshold,
        rulesEnabled
      });

      if (res.success) {
        this.flashSaveIndicator();
      }
    }, 200);
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
 * 域名跳转规则管理组件 (DomainRulesComponent)
 */
class DomainRulesComponent {
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
        await MessageBus.sendToBackground(ActionTypes.CLEAR_DOMAIN_RULES);
        Toast.show('已清空全部域名规则');
        await this.loadRules();
      }
    });

    // 3. 表格内操作事件委托
    this.tbody?.addEventListener('click', async (e) => {
      const btnDelete = e.target.closest('.btn-delete-rule');
      if (btnDelete) {
        const domain = btnDelete.dataset.domain;
        await MessageBus.sendToBackground(ActionTypes.REMOVE_DOMAIN_RULE, { domain });
        Toast.show(`已删除 ${domain} 的跳转规则`);
        await this.loadRules();
      }
    });

    this.tbody?.addEventListener('change', async (e) => {
      const select = e.target.closest('.table-select-mode');
      if (select) {
        const domain = select.dataset.domain;
        const mode = select.value;
        await MessageBus.sendToBackground(ActionTypes.SET_DOMAIN_RULE, { domain, mode });
        Toast.show(`已更新 ${domain} 跳转行为为 ${mode}`);
        await this.loadRules();
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

    await MessageBus.sendToBackground(ActionTypes.SET_DOMAIN_RULE, { domain: cleanDomain, mode });
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
  }

  escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

/**
 * 数据备份、导入与迁移管理组件 (BackupComponent)
 */
class BackupComponent {
  /**
   * @param {Function} onDataRestored - 恢复备份后通知全局刷新数据的回调
   */
  constructor(onDataRestored) {
    this.onDataRestored = onDataRestored;

    this.txtRestoreJSON = document.getElementById('restoreJSONTextarea');
    this.fileRestoreJSON = document.getElementById('fileRestoreJSON');
    this.btnRestoreFromText = document.getElementById('btnRestoreFromText');

    this.btnExportFullJSON = document.getElementById('btnExportFullJSON');
    this.btnCopyFullJSON = document.getElementById('btnCopyFullJSON');

    this.txtImportThirdParty = document.getElementById('importThirdPartyTextarea');
    this.btnImportThirdPartyText = document.getElementById('btnImportThirdPartyText');
    this.fileImportThirdParty = document.getElementById('fileImportThirdParty');

    this.btnCopyOneTabScript = document.getElementById('btnCopyOneTabScript');
    this.btnExportOneTabText = document.getElementById('btnExportOneTabText');
    this.btnCopyOneTabText = document.getElementById('btnCopyOneTabText');

    this.btnDeduplicate = document.getElementById('btnDeduplicateStash');
    this.btnClearAllStash = document.getElementById('btnClearAllStash');

    this.init();
  }

  init() {
    this.bindEvents();
  }

  bindEvents() {
    // 1. 导出完整 JSON 备份文件
    this.btnExportFullJSON?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_BACKUP_DATA);
      if (res.success && res.data) {
        const jsonStr = JSON.stringify(res.data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const filename = `better-browse-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        Toast.show('完整备份文件已成功导出');
      } else {
        Toast.show('导出失败');
      }
    });

    // 2. 复制完整 JSON 数据
    this.btnCopyFullJSON?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_BACKUP_DATA);
      if (res.success && res.data) {
        await navigator.clipboard.writeText(JSON.stringify(res.data, null, 2));
        Toast.show('完整备份数据已复制到剪贴板');
      }
    });

    // 3. 从文本恢复 JSON 备份
    this.btnRestoreFromText?.addEventListener('click', async () => {
      const raw = this.txtRestoreJSON?.value.trim();
      if (!raw) {
        Toast.show('请先粘贴备份 JSON 数据');
        return;
      }
      try {
        const backupData = JSON.parse(raw);
        await this.executeRestoreJSON(backupData);
      } catch (err) {
        Toast.show(`JSON 格式解析错误：${err.message}`);
      }
    });

    // 4. 选择 JSON 文件恢复
    this.fileRestoreJSON?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const backupData = JSON.parse(event.target.result);
          await this.executeRestoreJSON(backupData);
        } catch (err) {
          Toast.show(`文件解析失败：${err.message}`);
        }
        this.fileRestoreJSON.value = '';
      };
      reader.readAsText(file);
    });

    // 5. 从第三方文本解析导入
    this.btnImportThirdPartyText?.addEventListener('click', async () => {
      const raw = this.txtImportThirdParty?.value.trim();
      if (!raw) {
        Toast.show('请先粘贴待导入的文本内容');
        return;
      }
      await this.executeImportThirdParty(raw);
    });

    // 6. 选择第三方文件导入
    this.fileImportThirdParty?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target.result;
        if (typeof content === 'string') {
          await this.executeImportThirdParty(content);
        }
        this.fileImportThirdParty.value = '';
      };
      reader.readAsText(file);
    });

    // 7. 一键复制 OneTab 提取脚本
    this.btnCopyOneTabScript?.addEventListener('click', async () => {
      await navigator.clipboard.writeText('copy(localStorage.state)');
      Toast.show('已复制提取命令：copy(localStorage.state)！请至 OneTab 页面 F12 控制台粘贴执行');
    });

    // 8. 导出 OneTab 纯文本文件
    this.btnExportOneTabText?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_ONETAB_TEXT);
      if (res.success && typeof res.data === 'string') {
        const blob = new Blob([res.data], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `onetab-export-${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        Toast.show('OneTab 格式纯文本已成功导出');
      }
    });

    // 9. 复制 OneTab 格式纯文本
    this.btnCopyOneTabText?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_ONETAB_TEXT);
      if (res.success && typeof res.data === 'string') {
        await navigator.clipboard.writeText(res.data);
        Toast.show('OneTab 格式文本已复制到剪贴板');
      }
    });

    // 10. 智能去重
    this.btnDeduplicate?.addEventListener('click', async () => {
      this.btnDeduplicate.disabled = true;
      Toast.show('正在智能比对指纹并去重...');
      const res = await MessageBus.sendToBackground(ActionTypes.DEDUPLICATE_STASH_DATA);
      if (res.success && res.data) {
        const { removedCount, groupCountAfter } = res.data;
        if (removedCount > 0) {
          Toast.show(`去重完成！清理了 ${removedCount} 个重复标签组（剩余 ${groupCountAfter} 组）`);
          this.onDataRestored?.();
        } else {
          Toast.show('收纳箱中没有发现重复的标签组');
        }
      }
      this.btnDeduplicate.disabled = false;
    });

    // 11. 危险清空
    this.btnClearAllStash?.addEventListener('click', async () => {
      if (confirm('警告：此操作将清空收纳箱所有历史数据（锁定组除外）且无法撤销！\n\n确定要继续吗？')) {
        const res = await MessageBus.sendToBackground(ActionTypes.CLEAR_ALL_STASH);
        if (res.success) {
          Toast.show('已清空收纳箱非锁定数据');
          this.onDataRestored?.();
        }
      }
    });
  }

  async executeRestoreJSON(backupData) {
    if (!backupData || typeof backupData !== 'object') {
      Toast.show('备份数据无效');
      return;
    }
    const res = await MessageBus.sendToBackground(ActionTypes.RESTORE_BACKUP_DATA, { backupData });
    if (res.success) {
      Toast.show('全量数据恢复成功！配置与收纳箱已同步更新');
      if (this.txtRestoreJSON) this.txtRestoreJSON.value = '';
      this.onDataRestored?.();
    } else {
      Toast.show(res.error || '恢复失败');
    }
  }

  async executeImportThirdParty(rawText) {
    Toast.show('正在智能解析第三方数据...');
    const res = await MessageBus.sendToBackground(ActionTypes.IMPORT_ONETAB_TEXT, { rawText });
    if (res.success && res.data) {
      const { importedCount, groupCount, formatName } = res.data;
      Toast.show(`成功识别 [${formatName || '数据'}]：已导入 ${groupCount} 个标签组（共 ${importedCount} 个网页）`);
      if (this.txtImportThirdParty) this.txtImportThirdParty.value = '';
      this.onDataRestored?.();
    } else {
      Toast.show(res.error || '未能从输入中提取有效网页链接');
    }
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
    const stashSettingsComponent = new StashSettingsComponent();
    const rulesComponent = new RulesConfigComponent();
    const domainComponent = new DomainRulesComponent();
    new BackupComponent(() => {
      stashComponent.loadData();
      stashSettingsComponent.loadSettings();
      rulesComponent.loadConfig();
      domainComponent.loadRules();
    });

    // 接收来自后台的主动广播通知（双通道保障即时呈现）
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.action) return false;
      if (message.action === 'SWITCH_OPTIONS_TAB' && message.payload?.tab) {
        this.switchTab(message.payload.tab);
      } else if (message.action === ActionTypes.OPEN_OPTIONS_PAGE && message.payload?.tab) {
        this.switchTab(message.payload.tab);
      } else if (message.action === ActionTypes.NOTIFY_STASH_UPDATED) {
        stashComponent.loadData();
      } else if (message.action === ActionTypes.NOTIFY_RULE_UPDATED) {
        domainComponent.loadRules();
      } else if (message.action === ActionTypes.NOTIFY_CONFIG_UPDATED) {
        stashSettingsComponent.loadSettings();
        rulesComponent.loadConfig();
      }
      return false;
    });

    // 读取 URL Hash 路由 (如 #stash-settings, #rules, #links)
    const rawHash = window.location.hash.replace(/^#/, '');
    if (rawHash && document.getElementById(`tab-${rawHash}`)) {
      this.switchTab(rawHash);
    }
  }

  bindNavigation() {
    this.navItems.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        if (targetTab) {
          this.switchTab(targetTab);
        }
      });
    });
  }

  switchTab(tabName) {
    this.navItems.forEach((item) => {
      const isTarget = item.getAttribute('data-tab') === tabName;
      item.classList.toggle('active', isTarget);
      item.setAttribute('aria-selected', isTarget ? 'true' : 'false');
      item.tabIndex = isTarget ? 0 : -1;
    });

    this.panels.forEach((panel) => {
      if (panel.id === `tab-${tabName}`) {
        panel.classList.add('active');
        panel.hidden = false;
      } else {
        panel.classList.remove('active');
        panel.hidden = true;
      }
    });

    try {
      history.replaceState(null, '', `#${tabName}`);
    } catch {
      // 忽略历史状态异常
    }
  }
}

// 启动管理中心应用
document.addEventListener('DOMContentLoaded', () => {
  new OptionsApp();
});
