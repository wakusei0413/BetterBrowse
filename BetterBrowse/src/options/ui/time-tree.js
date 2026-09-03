/**
 * @file time-tree.js
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




export class TimeTreeBuilder {
  static getGroupTimestamp(group) {
    const timestamp = Number(group?.createdAt ?? group?.startTime);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  }

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
      label: `第 ${weekNum} 周 · ${startStr} ~ ${endStr}`
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

    const now = new Date();
    const todayYear = now.getFullYear();
    const todayMonth = now.getMonth() + 1;
    const todayDay = now.getDate();

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayYear = yesterday.getFullYear();
    const yesterdayMonth = yesterday.getMonth() + 1;
    const yesterdayDay = yesterday.getDate();

    const currentWeekInfo = this.getWeekInfo(now);

    const dayOfWeekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const pad = (n) => String(n).padStart(2, '0');

    // 存储年份节点的 Map: year -> { id, type, key, title, tag, groupCount, tabCount, firstGroupId, groupIds: Set, children: Map(month) }
    const yearMap = new Map();

    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const timestamp = this.getGroupTimestamp(group);
      const date = new Date(timestamp);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      const day = date.getDate();
      const tabCount = Number(group.itemCount ?? group.tabs?.length) || 0;

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
          tag: year === todayYear ? '今年' : '',
          isCurrentYear: year === todayYear,
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
        const isCurrentMonth = year === todayYear && month === todayMonth;
        monthNode = {
          id: `node_month_${year}_${pad(month)}`,
          type: 'month',
          key: `${year}-${pad(month)}`,
          title: `${pad(month)} 月`,
          tag: isCurrentMonth ? '本月' : '',
          isCurrentMonth,
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

      // 3. 周节点（key/id 以月份为命名空间：同一自然周可跨两个月，
      //    若仅用 ISO 周号作 key，跨月周会在两个月份节点下产生重复 key/id）
      let weekNode = monthNode.weeks.get(weekKey);
      if (!weekNode) {
        const isCurrentWeek = weekInfo.year === currentWeekInfo.year && weekInfo.weekNum === currentWeekInfo.weekNum;
        const scopedWeekKey = `${monthNode.key}_${weekKey}`;
        weekNode = {
          id: `node_week_${scopedWeekKey}`,
          type: 'week',
          key: scopedWeekKey,
          title: weekInfo.label,
          tag: isCurrentWeek ? '本周' : '',
          isCurrentWeek,
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
        const isToday = year === todayYear && month === todayMonth && day === todayDay;
        const isYesterday = year === yesterdayYear && month === yesterdayMonth && day === yesterdayDay;
        let dayTitle = `${pad(month)}-${pad(day)} ${dayName}`;
        let dayTag = '';
        if (isToday) {
          dayTitle = `今天 · ${pad(month)}-${pad(day)} ${dayName}`;
          dayTag = '今天';
        } else if (isYesterday) {
          dayTitle = `昨天 · ${pad(month)}-${pad(day)} ${dayName}`;
          dayTag = '昨天';
        }

        dayNode = {
          id: `node_day_${dayKey}`,
          type: 'day',
          key: dayKey,
          title: dayTitle,
          tag: dayTag,
          isToday,
          isYesterday,
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

  /**
   * 将全量收纳组扁平按周聚合为有序的时间切片块列表（按最新到最旧排列）
   * @param {Array<Object>} groups
   * @returns {Array<Object>}
   */
  static buildFlatChunks(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return [];
    const tree = TimeTreeBuilder.buildTree(groups);
    const chunks = [];
    let chunkIndex = 0;

    for (const yearNode of tree) {
      for (const monthNode of yearNode.children || []) {
        for (const weekNode of monthNode.children || []) {
          const monthNum = parseInt(monthNode.key.split('-')[1], 10);
          const weekNum = weekNode.key.split('-W')[1];
          chunks.push({
            index: chunkIndex++,
            type: 'week',
            key: weekNode.key,
            yearKey: yearNode.key,
            monthKey: monthNode.key,
            title: `${yearNode.key}年 ${monthNum}月 · 第${weekNum}周`,
            tag: weekNode.tag,
            groupCount: weekNode.groupCount,
            tabCount: weekNode.tabCount,
            firstGroupId: weekNode.firstGroupId,
            groupIds: weekNode.groupIds
          });
        }
      }
    }
    return chunks;
  }
}

/**
 * 纯单一直线时间轴分块导航条组件 (SingleLineTimelineScrollbar)
 * - 默认分块：初始进入默认只加载最新的一周
 * - 滚动切换：通过在时间轴滚轮滚动、拖拽滑块或主列表触底滚动，自动切换加载对应时段
 * - 宽大舒适热区：125px 独立右侧轨、清晰徽标与圆圈
 */

export class SingleLineTimelineScrollbar {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.container - 轴线节点容器 DOM
   * @param {HTMLElement} options.track - 滚动条轨道 DOM
   * @param {HTMLElement} options.thumb - 时间游标滑块 DOM
   * @param {Function} options.onSelectChunk - 选择分块加载回调 (chunkNode | null) => void
   */
  constructor(options) {
    this.container = options.container;
    this.track = options.track;
    this.thumb = options.thumb;
    this.onSelectChunk = options.onSelectChunk;

    this.expandedYears = new Set();
    this.expandedMonths = new Set();
    this.rawGroups = [];
    this.treeData = [];
    this.chunks = [];
    this.activeChunkIndex = 0; // 默认最新一周
    this.isDragging = false;
    this.wheelThrottleTimer = 0;

    this.init();
  }

  init() {
    this.bindEvents();
  }

  bindEvents() {
    // 1. 点击节点项切换分块
    this.container?.addEventListener('click', (e) => {
      const item = e.target.closest('.timeline-axis-item');
      if (!item) return;

      const isChevronClick = Boolean(e.target.closest('.axis-chevron'));
      const { type, key } = item.dataset;

      if (type === 'year') {
        const yearNode = this.treeData.find((y) => y.key === key);
        if (!yearNode) return;

        if (isChevronClick) {
          if (this.expandedYears.has(key)) {
            this.expandedYears.delete(key);
          } else {
            this.expandedYears.add(key);
          }
          this.render();
          return;
        }

        // 点击年份行：切换至该年份下的首个周分块
        this.expandedYears.add(key);
        const targetChunkIndex = this.chunks.findIndex((c) => c.yearKey === key);
        if (targetChunkIndex !== -1) {
          this.selectChunk(targetChunkIndex);
        }
      } else if (type === 'month') {
        if (isChevronClick) {
          if (this.expandedMonths.has(key)) {
            this.expandedMonths.delete(key);
          } else {
            this.expandedMonths.add(key);
          }
          this.render();
          return;
        }

        // 点击月份行：切换至该月份下的首个周分块
        this.expandedMonths.add(key);
        const targetChunkIndex = this.chunks.findIndex((c) => c.monthKey === key);
        if (targetChunkIndex !== -1) {
          this.selectChunk(targetChunkIndex);
        }
      } else if (type === 'week') {
        const targetChunkIndex = this.chunks.findIndex((c) => c.key === key);
        if (targetChunkIndex !== -1) {
          this.selectChunk(targetChunkIndex);
        }
      }
    });

    // 1.1 键盘可达性：时间轴节点支持 Enter / 空格触发切换（与点击行为一致）
    this.container?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const item = e.target.closest('.timeline-axis-item');
      if (!item) return;
      e.preventDefault();
      item.click();
    });

    // 2. 在时间轴滚动条区域滚动滚轮 -> 滚动切换时间分块
    this.track?.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const now = Date.now();
        if (now - this.wheelThrottleTimer < 140) return;
        this.wheelThrottleTimer = now;

        if (e.deltaY > 0) {
          // 向下滚 -> 切换至更早时段 (older chunk)
          this.stepNextChunk();
        } else if (e.deltaY < 0) {
          // 向上滚 -> 切换至更新时段 (newer chunk)
          this.stepPrevChunk();
        }
      },
      { passive: false }
    );

    // 3. 拖拽时间线游标滑块 (Scrubber Dragging)
    if (this.thumb && this.track) {
      this.thumb.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.isDragging = true;
        this.thumb.classList.add('is-dragging');

        const onMouseMove = (moveEvt) => {
          if (!this.isDragging || this.chunks.length === 0) return;
          moveEvt.preventDefault();
          const items = this.container ? Array.from(this.container.querySelectorAll('.timeline-axis-item')) : [];
          if (items.length === 0) return;

          const trackRect = this.track.getBoundingClientRect();
          const firstRect = items[0].getBoundingClientRect();
          const lastRect = items[items.length - 1].getBoundingClientRect();
          const minCenterY = firstRect.top - trackRect.top + this.track.scrollTop + items[0].offsetHeight / 2;
          const maxCenterY = lastRect.top - trackRect.top + this.track.scrollTop + items[items.length - 1].offsetHeight / 2;

          const currentY = moveEvt.clientY - trackRect.top + this.track.scrollTop;
          const clampedY = Math.max(minCenterY, Math.min(maxCenterY, currentY));
          const effectiveSpan = maxCenterY - minCenterY || 1;
          const ratio = Math.max(0, Math.min(1, (clampedY - minCenterY) / effectiveSpan));
          const targetIndex = Math.min(
            this.chunks.length - 1,
            Math.max(0, Math.round(ratio * (this.chunks.length - 1)))
          );
          if (targetIndex !== this.activeChunkIndex) {
            this.selectChunk(targetIndex);
          }
        };

        const onMouseUp = () => {
          if (this.isDragging) {
            this.isDragging = false;
            this.thumb.classList.remove('is-dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
          }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });

      // 点击轨道空白处跳到对应比例分块（严格限制在首尾节点有效范围）
      this.track.addEventListener('click', (e) => {
        if (e.target.closest('.timeline-axis-item') || e.target.closest('.timeline-scrubber-thumb')) {
          return;
        }
        if (this.chunks.length === 0) return;
        const items = this.container ? Array.from(this.container.querySelectorAll('.timeline-axis-item')) : [];
        if (items.length === 0) return;

        const trackRect = this.track.getBoundingClientRect();
        const firstRect = items[0].getBoundingClientRect();
        const lastRect = items[items.length - 1].getBoundingClientRect();
        const minCenterY = firstRect.top - trackRect.top + this.track.scrollTop + items[0].offsetHeight / 2;
        const maxCenterY = lastRect.top - trackRect.top + this.track.scrollTop + items[items.length - 1].offsetHeight / 2;

        const currentY = e.clientY - trackRect.top + this.track.scrollTop;
        const clampedY = Math.max(minCenterY, Math.min(maxCenterY, currentY));
        const effectiveSpan = maxCenterY - minCenterY || 1;
        const ratio = Math.max(0, Math.min(1, (clampedY - minCenterY) / effectiveSpan));
        const targetIndex = Math.min(
          this.chunks.length - 1,
          Math.max(0, Math.round(ratio * (this.chunks.length - 1)))
        );
        this.selectChunk(targetIndex);
      });
    }
  }

  /**
   * 刷新全量数据
   * @param {Array<Object>} allGroups - 全量收纳组
   */
  update(allGroups) {
    this.rawGroups = allGroups || [];
    // 重建前记录活动分块 key：数据变化后索引会漂移（同一索引可能指向别的周），按 key 恢复定位
    const prevActiveKey = this.getCurrentChunk()?.key ?? null;
    const wasAllChunks = this.activeChunkIndex === -1;

    this.treeData = TimeTreeBuilder.buildTree(this.rawGroups);
    this.chunks = TimeTreeBuilder.buildFlatChunks(this.rawGroups);

    if (wasAllChunks) {
      this.activeChunkIndex = -1;
    } else {
      const matchedIndex = prevActiveKey ? this.chunks.findIndex((c) => c.key === prevActiveKey) : -1;
      this.activeChunkIndex = matchedIndex !== -1 ? matchedIndex : (this.chunks.length > 0 ? 0 : -1);
    }

    if (this.activeChunkIndex >= 0 && this.chunks[this.activeChunkIndex]) {
      const cur = this.chunks[this.activeChunkIndex];
      // 自动回收机制：仅展开当前活动分块所在的年份与月份，自动收起其他非活跃分支，保持导航精简
      this.expandedYears.clear();
      this.expandedMonths.clear();
      this.expandedYears.add(cur.yearKey);
      this.expandedMonths.add(cur.monthKey);
    }

    this.render();
    this.syncThumbPosition();
  }

  /**
   * 选择并加载指定索引的时间分块
   * @param {number} index - 分块索引 (0 为最新，-1 为全部)
   * @param {boolean} [triggerCallback=true]
   */
  selectChunk(index, triggerCallback = true) {
    if (index < -1) index = -1;
    if (index >= this.chunks.length) index = this.chunks.length - 1;

    this.activeChunkIndex = index;

    if (index >= 0 && this.chunks[index]) {
      const cur = this.chunks[index];
      // 自动回收机制：仅展开当前活动分块所在的年份与月份，自动收起其他非活跃分支，保持导航精简
      this.expandedYears.clear();
      this.expandedMonths.clear();
      this.expandedYears.add(cur.yearKey);
      this.expandedMonths.add(cur.monthKey);
    }

    this.render();
    this.syncThumbPosition();

    if (triggerCallback) {
      this.onSelectChunk?.(this.getCurrentChunk());
    }
  }

  getCurrentChunk() {
    if (this.activeChunkIndex === -1 || !this.chunks[this.activeChunkIndex]) {
      return null;
    }
    return this.chunks[this.activeChunkIndex];
  }

  /**
   * 步进至下一个更早的时间分块
   */
  stepNextChunk() {
    if (this.chunks.length === 0) return;
    if (this.activeChunkIndex === -1) {
      this.selectChunk(0);
      return;
    }
    if (this.activeChunkIndex < this.chunks.length - 1) {
      this.selectChunk(this.activeChunkIndex + 1);
    }
  }

  /**
   * 步进至上一个更新的时间分块
   */
  stepPrevChunk() {
    if (this.chunks.length === 0) return;
    if (this.activeChunkIndex > 0) {
      this.selectChunk(this.activeChunkIndex - 1);
    }
  }

  /**
   * 同步游标在轴线上的精确纵向位置
   */
  syncThumbPosition() {
    if (!this.track || !this.thumb) return;

    const items = this.container ? Array.from(this.container.querySelectorAll('.timeline-axis-item')) : [];
    if (items.length === 0 || this.activeChunkIndex === -1 || this.chunks.length === 0) {
      this.thumb.style.opacity = '0';
      this.thumb.style.pointerEvents = 'none';
      return;
    }

    const trackRect = this.track.getBoundingClientRect();
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    const firstRect = firstItem.getBoundingClientRect();
    const lastRect = lastItem.getBoundingClientRect();

    // 首末节点的中心纵坐标（在轨道内容坐标系中）
    const minCenterY = firstRect.top - trackRect.top + this.track.scrollTop + firstItem.offsetHeight / 2;
    const maxCenterY = lastRect.top - trackRect.top + this.track.scrollTop + lastItem.offsetHeight / 2;

    const curChunk = this.chunks[this.activeChunkIndex];
    let targetItem = null;

    if (curChunk) {
      // 1. 优先匹配当前活动周节点
      targetItem = this.container.querySelector(`.timeline-axis-item[data-key="${CSS.escape(curChunk.key)}"]`);
      // 2. 若周节点被折叠隐藏，退回匹配对应月份节点
      if (!targetItem && curChunk.monthKey) {
        targetItem = this.container.querySelector(`.timeline-axis-item[data-key="${CSS.escape(curChunk.monthKey)}"]`);
      }
      // 3. 若月份节点也被折叠隐藏，退回匹配对应年份节点
      if (!targetItem && curChunk.yearKey) {
        targetItem = this.container.querySelector(`.timeline-axis-item[data-key="${CSS.escape(curChunk.yearKey)}"]`);
      }
    }

    let targetY = minCenterY;
    if (targetItem) {
      const itemRect = targetItem.getBoundingClientRect();
      targetY = itemRect.top - trackRect.top + this.track.scrollTop + targetItem.offsetHeight / 2;
    } else {
      const ratio = this.chunks.length > 1 ? this.activeChunkIndex / (this.chunks.length - 1) : 0;
      targetY = minCenterY + ratio * (maxCenterY - minCenterY);
    }

    // 严密夹逼限制在首尾节点圆心之间，彻底杜绝越界溢出到首项上方或末项下方
    const clampedY = Math.max(minCenterY, Math.min(maxCenterY, targetY));
    this.thumb.style.transform = `translateY(${clampedY}px)`;
    this.thumb.style.opacity = '1';
    this.thumb.style.pointerEvents = 'auto';
  }

  /**
   * 主列表滚动联动（ScrollSpy）：按当前视口顶部组同步时间轴高亮节点与游标位置。
   * 仅做视觉同步，不触发 onSelectChunk 重载主列表，避免滚动↔加载循环。
   * @param {number} ratio - 主列表滚动比例 (0~1)
   * @param {string|null} groupId - 当前视口顶部组 ID（null 时仅按比例移动游标）
   */
  syncScrollProgress(ratio, groupId) {
    if (!this.track || !this.thumb) return;

    if (this.chunks.length === 0 || this.activeChunkIndex === -1) {
      this.thumb.style.opacity = '0';
      return;
    }

    if (groupId) {
      const targetIndex = this.chunks.findIndex((c) => c.groupIds?.has(groupId));
      if (targetIndex !== -1 && targetIndex !== this.activeChunkIndex) {
        // 静默切换活动分块：同步展开层级并重绘高亮，但不触发回调重载
        this.activeChunkIndex = targetIndex;
        const cur = this.chunks[targetIndex];
        // 自动回收机制：滚动切换到新分块时自动逐级收起旧分支
        this.expandedYears.clear();
        this.expandedMonths.clear();
        this.expandedYears.add(cur.yearKey);
        this.expandedMonths.add(cur.monthKey);
        this.render();
      }
    }

    this.syncThumbPosition();
  }

  render() {
    if (!this.container) return;

    // 重建前记录键盘焦点所在节点：重建后按 key 恢复焦点，避免键盘用户丢失位置
    const focusedKey = this.container.querySelector('.timeline-axis-item:focus')?.dataset.key || null;

    if (!this.treeData || this.treeData.length === 0) {
      this.container.innerHTML = '';
      return;
    }

    const activeChunk = this.getCurrentChunk();
    const flatItems = [];

    for (const yearNode of this.treeData) {
      const isYearExpanded = this.expandedYears.has(yearNode.key);
      const hasMonths = Array.isArray(yearNode.children) && yearNode.children.length > 0;
      const isYearActive = activeChunk?.yearKey === yearNode.key;

      flatItems.push({
        type: 'year',
        key: yearNode.key,
        label: `${yearNode.key}年`,
        badge: yearNode.groupCount,
        isActiveChunk: isYearActive && !activeChunk?.monthKey,
        hasChildren: hasMonths,
        isExpanded: isYearExpanded
      });

      if (isYearExpanded && hasMonths) {
        for (const monthNode of yearNode.children) {
          const isMonthExpanded = this.expandedMonths.has(monthNode.key);
          const hasWeeks = Array.isArray(monthNode.children) && monthNode.children.length > 0;
          const monthNum = parseInt(monthNode.key.split('-')[1], 10);
          const isMonthActive = activeChunk?.monthKey === monthNode.key;

          flatItems.push({
            type: 'month',
            key: monthNode.key,
            label: `${monthNum}月`,
            badge: monthNode.groupCount,
            isActiveChunk: isMonthActive && !activeChunk?.key,
            hasChildren: hasWeeks,
            isExpanded: isMonthExpanded
          });

          if (isMonthExpanded && hasWeeks) {
            for (const weekNode of monthNode.children) {
              const weekNum = weekNode.key.split('-W')[1];
              const isWeekActive = activeChunk?.key === weekNode.key;

              flatItems.push({
                type: 'week',
                key: weekNode.key,
                label: `第${weekNum}周`,
                badge: weekNode.groupCount,
                isActiveChunk: isWeekActive,
                hasChildren: false,
                isExpanded: false
              });
            }
          }
        }
      }
    }

    const html = flatItems
      .map((item) => {
        let circleHtml = '';
        if (item.type === 'year') {
          circleHtml = `<div class="axis-circle circle-year"><div class="circle-core"></div></div>`;
        } else if (item.type === 'month') {
          circleHtml = `<div class="axis-circle circle-month"></div>`;
        } else {
          circleHtml = `<div class="axis-circle circle-week"></div>`;
        }

        let chevronHtml = '';
        if (item.hasChildren) {
          chevronHtml = `<span class="axis-chevron ${item.isExpanded ? 'is-expanded' : ''}">▶</span>`;
        }

        // 不再使用原生 title 提示（时间轴贴屏幕右缘时原生提示必然被裁切且悬停噪音大），
        // 语义信息通过 role + aria-label 提供给读屏器
        return `
          <div class="timeline-axis-item axis-item-${item.type} ${item.isActiveChunk ? 'is-active-chunk' : ''}"
               data-type="${item.type}"
               data-key="${item.key}"
               role="button"
               tabindex="0"
               aria-label="${item.label}，共 ${item.badge} 组">
            ${circleHtml}
            <div class="axis-main">
              <span class="axis-label">${item.label}</span>
              ${chevronHtml}
            </div>
            <span class="axis-badge">${item.badge}</span>
          </div>
        `;
      })
      .join('');

    this.container.innerHTML = html;

    if (focusedKey) {
      this.container.querySelector(`.timeline-axis-item[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
    }
  }
}

/**
 * 标签收纳箱主组件 (StashTabComponent)
 */
