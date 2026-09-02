/**
 * @file options.js
 * @description 选项与收纳管理中心视图控制器（完全对标 OneTab 并支持四级时间树索引、即地命名、5秒撤销、14项偏好设置、无感刷新与自动保存）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { StorageKeys } from '../constants/storage-keys.js';
import { LinkModes, LOCAL_DATA_SCHEMA_REVISION } from '../constants/config.js';
import { API_VERSION } from '../constants/api-version.js';
import { LinkMatcher } from '../core/link/link-matcher.js';
import { MessageBus } from '../core/bus/message-bus.js';
import { installRuntimeLogger } from '../core/logging/runtime-logger.js';
import {
  GROUP_OVERSCAN,
  TAB_OVERSCAN,
  TABS_INITIAL_LIMIT,
  computePads,
  estimateGroupCardHeight,
  getDensityMetrics,
  getItemWindow,
  getVisibleRange
} from './list-window.js';

installRuntimeLogger({
  context: 'options',
  write: (entry) => MessageBus.sendToBackground(ActionTypes.APPEND_RUNTIME_LOG, entry)
});

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
 * 现代扁平化自定义下拉菜单增强器 (CustomSelectEnhancer)
 * - 零侵入替换原生简陋直角 select 弹层为现代扁平卡片浮层
 * - 支持深浅色自适应、Checkmark 勾选标识、微动画过渡、上下键导航与无障碍
 * - 双向同步底层原生 select 的 value 与 change 事件
 */
class CustomSelectEnhancer {
  static _initialized = false;

  static init() {
    if (this._initialized) return;
    this._initialized = true;

    // 点击页面外部区域自动收起所有已打开的自定义下拉框
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.custom-select-wrapper')) {
        document.querySelectorAll('.custom-select-wrapper.is-open').forEach((el) => {
          el.classList.remove('is-open', 'drop-up');
          el.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
        });
      }
    });

    // 按 Escape 键收起所有已打开的下拉框
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.custom-select-wrapper.is-open').forEach((el) => {
          el.classList.remove('is-open', 'drop-up');
          el.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
        });
      }
    });
  }

  /**
   * 增强指定容器下的所有 select.form-select 元素
   * @param {HTMLElement|Document} [root=document]
   */
  static enhanceAll(root = document) {
    this.init();
    if (!root) return;
    const selects = root.querySelectorAll ? root.querySelectorAll('select.form-select') : [];
    selects.forEach((select) => this.enhance(select));
  }

  /**
   * 增强单个 select 元素
   * @param {HTMLSelectElement} select
   */
  static enhance(select) {
    if (!select || select.tagName !== 'SELECT') return;
    this.init();

    let wrapper = select.closest('.custom-select-wrapper');
    if (wrapper) {
      this.sync(select);
      return;
    }

    wrapper = document.createElement('div');
    wrapper.className = 'custom-select-wrapper';
    if (select.classList.contains('btn-sm')) wrapper.classList.add('btn-sm');
    if (select.classList.contains('w-full')) wrapper.classList.add('w-full');

    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    const trigger = document.createElement('button');
    trigger.className = 'custom-select-trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const labelSpan = document.createElement('span');
    labelSpan.className = 'select-trigger-label';

    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'select-trigger-arrow';
    arrowSpan.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6"></path>
      </svg>
    `;

    trigger.appendChild(labelSpan);
    trigger.appendChild(arrowSpan);
    wrapper.appendChild(trigger);

    const dropdown = document.createElement('div');
    dropdown.className = 'custom-select-dropdown';
    dropdown.setAttribute('role', 'listbox');
    wrapper.appendChild(dropdown);

    // 绑定触发器点击事件
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = wrapper.classList.contains('is-open');

      // 先关闭其他已打开的下拉框
      document.querySelectorAll('.custom-select-wrapper.is-open').forEach((el) => {
        if (el !== wrapper) {
          el.classList.remove('is-open', 'drop-up');
          el.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
        }
      });

      if (!isOpen) {
        // 计算视口空间，智能决定是否向上展开
        const rect = wrapper.getBoundingClientRect();
        const dropdownHeight = 220;
        const spaceBelow = window.innerHeight - rect.bottom;
        const shouldDropUp = spaceBelow < dropdownHeight && rect.top > dropdownHeight;
        wrapper.classList.toggle('drop-up', shouldDropUp);
        wrapper.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');

        // 聚焦到当前已选中的选项
        const selectedOpt = dropdown.querySelector('.custom-select-option.is-selected');
        if (selectedOpt) {
          dropdown.querySelectorAll('.custom-select-option').forEach((opt) => opt.classList.remove('is-highlighted'));
          selectedOpt.classList.add('is-highlighted');
          selectedOpt.scrollIntoView({ block: 'nearest' });
        }
      } else {
        wrapper.classList.remove('is-open', 'drop-up');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    // 键盘无障碍支持
    trigger.addEventListener('keydown', (e) => {
      const isOpen = wrapper.classList.contains('is-open');
      const options = Array.from(dropdown.querySelectorAll('.custom-select-option'));
      const highlightedIdx = options.findIndex((opt) => opt.classList.contains('is-highlighted'));

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) {
          trigger.click();
          return;
        }
        let nextIdx = 0;
        if (highlightedIdx === -1) {
          nextIdx = e.key === 'ArrowDown' ? 0 : options.length - 1;
        } else {
          nextIdx = e.key === 'ArrowDown' ? (highlightedIdx + 1) % options.length : (highlightedIdx - 1 + options.length) % options.length;
        }
        options.forEach((opt, idx) => {
          opt.classList.toggle('is-highlighted', idx === nextIdx);
          if (idx === nextIdx) opt.scrollIntoView({ block: 'nearest' });
        });
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isOpen) {
          const current = options[highlightedIdx] || dropdown.querySelector('.custom-select-option.is-selected');
          if (current) current.click();
        } else {
          trigger.click();
        }
      }
    });

    // 监听原生 select 变化，保持同步
    select.addEventListener('change', () => {
      CustomSelectEnhancer.sync(select);
    });

    this.sync(select);
  }

  /**
   * 同步选项列表与当前选中态
   * @param {HTMLSelectElement} select
   */
  static sync(select) {
    if (!select) return;
    const wrapper = select.closest('.custom-select-wrapper');
    if (!wrapper) {
      this.enhance(select);
      return;
    }

    const labelSpan = wrapper.querySelector('.select-trigger-label');
    const dropdown = wrapper.querySelector('.custom-select-dropdown');
    if (!dropdown) return;

    const selectedOption = select.options[select.selectedIndex] || select.options[0];
    if (labelSpan && selectedOption) {
      labelSpan.textContent = selectedOption.textContent;
    }

    // 重建下拉选项列表
    dropdown.innerHTML = '';
    Array.from(select.options).forEach((opt) => {
      const item = document.createElement('div');
      item.className = 'custom-select-option';
      item.dataset.value = opt.value;
      item.setAttribute('role', 'option');

      const isSelected = opt.value === select.value || (opt.selected && !select.value);
      if (isSelected) {
        item.classList.add('is-selected');
        item.setAttribute('aria-selected', 'true');
      }

      item.innerHTML = `
        <span>${opt.textContent}</span>
        <svg class="option-check-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const value = item.dataset.value;
        if (select.value !== value) {
          select.value = value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.dispatchEvent(new Event('input', { bubbles: true }));
        }
        CustomSelectEnhancer.sync(select);
        wrapper.classList.remove('is-open', 'drop-up');
        const trigger = wrapper.querySelector('.custom-select-trigger');
        trigger?.setAttribute('aria-expanded', 'false');
        trigger?.focus();
      });

      dropdown.appendChild(item);
    });
  }
}

/**
 * 收纳时间线构建器与聚合算法（年 > 月 > 周 > 日）
 */
class TimeTreeBuilder {
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
class SingleLineTimelineScrollbar {
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
class StashTabComponent {
  constructor() {
    this.groups = [];
    this.filteredGroups = [];
    this.groupPages = new Map();
    this.searchItemFilter = null;
    this.expandedGroupIds = new Set();
    this.pinnedGroupIds = new Set();
    this.recentlyDeletedGroups = new Map();
    this.searchDebounceTimer = null;
    this.activeTimeRangeFilter = null;
    this.filterToken = 0;
    this.loadGeneration = 0;
    this.mountedRange = null;
    this.measuredCardHeights = new Map();
    this.itemWindowByGroup = new Map();
    this.pageLoaders = new Map();
    this.windowSyncTicking = false;

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
    if (this.loadingIndicator) this.loadingIndicator.classList.add('hidden');
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

    // 立即全量收纳全部窗口
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

    // 6. 图标加载失败自动回退为默认网页 SVG 图标，保持对齐排版
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
    this.pinnedGroupIds = new Set();
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

  async filterAndRender(options = {}) {
    const token = ++this.filterToken;
    const query = this.searchInput?.value.toLowerCase().trim() || '';
    const inTimeRange = (groupId) =>
      !this.activeTimeRangeFilter || this.activeTimeRangeFilter.groupIds.has(groupId);

    this.filteredGroups = this.groups.filter((grp) => inTimeRange(grp.id));
    this.searchItemFilter = null;

    if (query) {
      const res = await MessageBus.sendToBackground(ActionTypes.SEARCH_STASH, {
        keyword: query,
        limit: 100,
        paginated: true
      });
      if (token !== this.filterToken) return;
      const hits = Array.isArray(res?.data) ? res.data : (Array.isArray(res?.data?.items) ? res.data.items : []);
      const hitsByGroup = new Map();
      for (const hit of res?.success ? hits : []) {
        if (!hit?.groupId || !inTimeRange(hit.groupId)) continue;
        if (!hitsByGroup.has(hit.groupId)) hitsByGroup.set(hit.groupId, []);
        hitsByGroup.get(hit.groupId).push({
          id: hit.itemId,
          url: hit.url,
          title: hit.title,
          favIconUrl: ''
        });
      }
      this.searchItemFilter = hitsByGroup;
      this.filteredGroups = this.filteredGroups.filter((grp) => {
        const titleMatch = Boolean(grp.title && grp.title.toLowerCase().includes(query));
        return titleMatch || hitsByGroup.has(grp.id);
      });
    }

    this.mountedRange = null;
    if (this.filteredGroups.length === 0) {
      this.renderEmptyState(Boolean(query));
      return;
    }
    if (this.emptyState) this.emptyState.style.display = 'none';
    if (this.loadingIndicator) this.loadingIndicator.classList.add('hidden');
    this.syncListWindow();
    if (options.preserveScroll && this.mainColumn) {
      this.mainColumn.scrollTop = Number(options.scrollTop) || 0;
      this.syncListWindow();
    }
  }

  /**
   * 区分"真为空"与"搜索无结果"
   * @param {boolean} hasSearchQuery
   */
  renderEmptyState(hasSearchQuery) {
    const titleEl = this.emptyState?.querySelector('.empty-title');
    const descEl = this.emptyState?.querySelector('.empty-desc');
    if (titleEl) titleEl.textContent = hasSearchQuery ? '未找到匹配的标签页' : '时间线目前是空的';
    if (descEl) {
      descEl.textContent = hasSearchQuery
        ? '请尝试更换搜索关键词。'
        : '当您在右上角点击「立即收纳」或标签页数量超出阈值时，未活跃标签将自动保存于此处。';
    }
    if (!this.container || !this.emptyState) return;
    this.container.replaceChildren(this.emptyState);
    this.emptyState.style.display = 'flex';
    if (this.loadingIndicator) this.loadingIndicator.classList.add('hidden');
    this.topSpacer = null;
    this.bottomSpacer = null;
  }

  getSearchQuery() {
    return this.searchInput?.value.toLowerCase().trim() || '';
  }

  /**
   * 当前过滤条件下该组应展示的条目数（决定卡片高度）
   * @param {any} group
   * @returns {number}
   */
  getVisibleItemCount(group) {
    const query = this.getSearchQuery();
    if (query) {
      return this.searchItemFilter?.get(group.id)?.length || 0;
    }
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
      if (!card) {
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
      if (this.getSearchQuery() && this.searchItemFilter?.has(group.id)) continue;
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

  async fetchAllGroupItems(groupId) {
    const items = [];
    let offset = 0;
    while (true) {
      const res = await MessageBus.sendToBackground(ActionTypes.GET_STASH_GROUP_PAGE, {
        groupId,
        offset,
        limit: 500
      });
      if (!res?.success || !res.data) break;
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
    const query = this.getSearchQuery();
    const useVirtual =
      (this.expandedGroupIds.has(group.id) || (query && (this.searchItemFilter?.get(group.id)?.length || 0) > TABS_INITIAL_LIMIT)) &&
      total > TABS_INITIAL_LIMIT;
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
    const query = this.getSearchQuery();
    const searchItems = query ? this.searchItemFilter?.get(group.id) : null;
    const cache = this.getGroupPageCache(group.id);
    const rows = [];
    for (let i = window.start; i < window.end; i++) {
      const tab = searchItems ? searchItems[i] : cache.slots.get(i);
      if (tab) rows.push(this.renderItemRowHtml(group.id, tab));
    }
    return rows.join('');
  }

  renderItemRowHtml(groupId, tab) {
    const safeGroupId = this.escapeHTML(groupId);
    const safeTabId = this.escapeHTML(tab.id);
    const faviconSrc = tab.favIconUrl;
    return `
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
            <a href="${this.escapeHTML(tab.url || '')}" class="tab-link btn-restore-item-link" data-group-id="${safeGroupId}" data-item-id="${safeTabId}" title="${this.escapeHTML(tab.title || tab.url || '')}&#10;${this.escapeHTML(tab.url || '')}">
              <span class="tab-title">${this.escapeHTML(tab.title || tab.url || '')}</span>
            </a>
          </div>
          <div class="tab-item-actions">
            <button class="btn-icon-danger btn-edit-item" data-group-id="${safeGroupId}" data-item-id="${safeTabId}" title="编辑标题" type="button" aria-label="编辑标题">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
              </svg>
            </button>
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
    const searching = Boolean(this.getSearchQuery());
    const hasMoreTabs = !searching && tabCount > TABS_INITIAL_LIMIT && !this.expandedGroupIds.has(group.id);
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

    const createdAt = TimeTreeBuilder.getGroupTimestamp(group);
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
    const tabCount = Number(group.itemCount) || 0;
    const displayGroupName = group.title || `${tabCount} 个标签页`;
    const safeGroupId = this.escapeHTML(group.id);
    const itemWindow = this.resolveItemWindow(group, null);
    const itemsHtml = this.buildItemRowsHtml(group, itemWindow);
    const searching = Boolean(this.getSearchQuery());
    const hasMoreTabs = !searching && tabCount > TABS_INITIAL_LIMIT && !this.expandedGroupIds.has(group.id);

    card.innerHTML = `
      <div class="stash-group-header">
        <div class="stash-header-left">
          <div class="stash-title-block" title="双击重命名标签组">
            <svg class="group-bullet-icon" ${group.color ? `data-color="${this.escapeHTML(group.color)}"` : ''} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
                  <svg viewBox="0 0 24 24" width="14" height="14" style="fill: ${group.starred ? 'var(--star-color)' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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

      <ul class="stash-items-list${itemWindow.padTop || itemWindow.padBottom ? ' is-virtual' : ''}" style="${itemWindow.padTop ? `padding-top:${itemWindow.padTop}px;` : ''}${itemWindow.padBottom ? `padding-bottom:${itemWindow.padBottom}px;` : ''}">
        ${itemsHtml}
      </ul>

      ${hasMoreTabs ? `
        <button class="btn-show-more-tabs" data-id="${safeGroupId}" type="button">
          展开其余 ${tabCount - TABS_INITIAL_LIMIT} 个标签页...
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
    if (diffSec < 31536000) return `${Math.max(1, Math.floor(diffSec / 2592000))} 个月前`;
    return `${Math.floor(diffSec / 31536000)} 年前`;
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
      Toast.show(`正在后台还原 ${group?.itemCount || 0} 个网页...`);
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
      if (!wasOpen) {
        wrapper.classList.add('open');
        const groupId = btnToggleDropdown.dataset.id;
        if (groupId) this.pinnedGroupIds.add(groupId);
      } else if (btnToggleDropdown.dataset.id) {
        this.pinnedGroupIds.delete(btnToggleDropdown.dataset.id);
      }
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

      // 消费 deleteConfirmation 设置：开启时删除前需二次确认
      if (await this.shouldConfirmDelete()) {
        const confirmed = window.confirm(`确定删除收纳组「${targetGroup.title || groupId}」吗？（删除后 5 秒内可撤销）`);
        if (!confirmed) return;
      }

      const snapshotTabs = await this.fetchAllGroupItems(groupId);
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

      await MessageBus.sendToBackground(ActionTypes.DELETE_STASH_GROUP, { groupId });
      await this.loadData();

      Toast.show('已删除该收纳组', 5000, {
        text: '撤销',
        onClick: async () => {
          const cached = this.recentlyDeletedGroups.get(groupId);
          if (cached) {
            // 撤销走"单组快照恢复"专用通道：仅写回被删除的这一个组，
            // 不经过全量备份管线（该管线会追加导入现有组并触发配置/规则恢复）
            const res = await MessageBus.sendToBackground(ActionTypes.RESTORE_STASH_GROUP_DATA, {
              group: cached.group
            });
            this.recentlyDeletedGroups.delete(groupId);
            await this.loadData();
            if (res?.success) {
              Toast.show('已成功恢复该收纳组');
            } else {
              Toast.show(`恢复失败：${res?.error || '存储写入异常'}`);
            }
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
      const items = await this.fetchAllGroupItems(groupId);
      if (items.length > 0) {
        const text = items.map((t) => `${t.url} | ${t.title}`).join('\n');
        await navigator.clipboard.writeText(text);
        Toast.show(`已复制该组全部 ${items.length} 个网页链接到剪贴板`);
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

    // 9b. 编辑单条标题
    const btnEditItem = e.target.closest('.btn-edit-item');
    if (btnEditItem) {
      e.preventDefault();
      this.startInlineItemEdit(btnEditItem.dataset.groupId, btnEditItem.dataset.itemId);
      return;
    }

    // 10. 展开超长组内所有标签
    const btnShowMore = e.target.closest('.btn-show-more-tabs');
    if (btnShowMore) {
      e.preventDefault();
      const groupId = btnShowMore.dataset.id;
      const scrollTop = this.mainColumn?.scrollTop || 0;
      this.expandedGroupIds.add(groupId);
      this.measuredCardHeights.delete(groupId);
      const group = this.groups.find((item) => item.id === groupId);
      const card = btnShowMore.closest('.stash-group-card');
      if (group && card) {
        this.refreshCardItems(card, group);
        this.ensureSlots(groupId, 0, Math.min(Number(group.itemCount) || 0, TABS_INITIAL_LIMIT + TAB_OVERSCAN)).then((result) => {
          if (result.changed) this.refreshCardItems(card, group);
          if (result.failed) card.dataset.pageLoadState = 'failed';
          else delete card.dataset.pageLoadState;
          this.syncListWindow();
          if (this.mainColumn) this.mainColumn.scrollTop = scrollTop;
        });
      } else {
        this.syncListWindow();
      }
      return;
    }
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
    document.documentElement.dataset.displayDensity = settings.displayDensity || 'comfortable';

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
    if (this.dom.selectDisplayDensity) {
      this.dom.selectDisplayDensity.value = settings.displayDensity || 'comfortable';
    }
    if (this.dom.chkAutoBackupEnabled) {
      this.dom.chkAutoBackupEnabled.checked = settings.autoBackupEnabled !== false;
    }
    if (this.dom.selectBackupRetentionDays) {
      this.dom.selectBackupRetentionDays.value = String(settings.backupRetentionDays || 30);
    }
    CustomSelectEnhancer.enhanceAll(document.getElementById('tab-settings'));
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
        displayDensity: this.dom.selectDisplayDensity?.value || 'comfortable',
        autoBackupEnabled: Boolean(this.dom.chkAutoBackupEnabled?.checked),
        backupRetentionDays: parseInt(this.dom.selectBackupRetentionDays?.value || '30', 10)
      };

      const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
        stashSettings
      });

      if (res.success) {
        document.documentElement.dataset.displayDensity = stashSettings.displayDensity;
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
      chkTieredStash: document.getElementById('chkTieredStash'),
      inputTierStepSeconds: document.getElementById('inputTierStepSeconds'),
      inputTierMaxLevels: document.getElementById('inputTierMaxLevels'),
      inputTierSafetyMargin: document.getElementById('inputTierSafetyMargin'),
      chkTierUltimateFallback: document.getElementById('chkTierUltimateFallback'),
      rowTierStepSeconds: document.getElementById('rowTierStepSeconds'),
      rowTierMaxLevels: document.getElementById('rowTierMaxLevels'),
      rowTierSafetyMargin: document.getElementById('rowTierSafetyMargin'),
      rowTierUltimateFallback: document.getElementById('rowTierUltimateFallback'),
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
        this.saveConfig();
      });
      if (el.type === 'number') {
        el.addEventListener('input', () => this.saveConfig());
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
    this.autoBackupList = document.getElementById('autoBackupList');

    this.init();
  }

  init() {
    this.bindEvents();
    this.loadAutoBackups();
  }

  bindEvents() {
    // 1. 导出完整 JSON 备份文件
    this.btnExportFullJSON?.addEventListener('click', async () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const filename = `better-browse-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
      try {
        if (typeof window.showSaveFilePicker === 'function') {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
          });
          const writable = await handle.createWritable();
          let cursor = null;
          let expectedStashRevision;
          do {
            const res = await MessageBus.sendToBackground(ActionTypes.READ_EXPORT_CHUNK, {
              type: 'full_backup',
              cursor,
              expectedStashRevision
            });
            if (!res.success || !res.data?.chunk) throw new Error(res.error || res.data?.error || '导出失败');
            await writable.write(res.data.chunk);
            cursor = res.data.nextCursor;
            expectedStashRevision = res.data.stashRevision;
          } while (cursor);
          await writable.close();
          Toast.show('完整备份文件已成功导出');
          return;
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.warn('[Backup] 流式导出失败，回退完整备份:', err);
      }
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_FULL_BACKUP);
      if (res.success && res.data) {
        const jsonStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
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
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_FULL_BACKUP);
      if (res.success && res.data) {
        const jsonStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
        await navigator.clipboard.writeText(jsonStr);
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
      } else {
        Toast.show(`导出失败：${res?.error || '后台服务异常，请稍后重试'}`);
      }
    });

    // 9. 复制 OneTab 格式纯文本
    this.btnCopyOneTabText?.addEventListener('click', async () => {
      const res = await MessageBus.sendToBackground(ActionTypes.EXPORT_ONETAB_TEXT);
      if (res.success && typeof res.data === 'string') {
        await navigator.clipboard.writeText(res.data);
        Toast.show('OneTab 格式文本已复制到剪贴板');
      } else {
        Toast.show(`导出失败：${res?.error || '后台服务异常，请稍后重试'}`);
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
      } else {
        Toast.show(res.error || '去重失败');
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

  async loadAutoBackups() {
    if (!this.autoBackupList) return;
    const res = await MessageBus.sendToBackground(ActionTypes.LIST_AUTO_BACKUPS);
    const items = Array.isArray(res?.data) ? res.data : [];
    this.autoBackupList.innerHTML = '';
    if (!res?.success || items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sync-empty';
      empty.id = 'autoBackupEmpty';
      empty.textContent = '暂无自动快照（可在收纳箱设置中开启每日快照）';
      this.autoBackupList.appendChild(empty);
      return;
    }
    for (const backup of items) {
      const createdAt = Number(backup.createdAt) || 0;
      const row = document.createElement('div');
      row.className = 'conflict-item';

      const head = document.createElement('div');
      head.className = 'conflict-head';
      head.textContent = createdAt ? new Date(createdAt).toLocaleString('zh-CN') : '未知时间';

      const meta = document.createElement('div');
      meta.className = 'device-meta';
      meta.textContent = `${backup.groupCount ?? 0} 组 · ${backup.entryCount ?? 0} 条`;

      const actions = document.createElement('div');
      actions.className = 'btn-group';
      const btnRestore = document.createElement('button');
      btnRestore.className = 'btn btn-secondary btn-sm';
      btnRestore.type = 'button';
      btnRestore.textContent = '恢复';
      btnRestore.addEventListener('click', () => this.restoreAutoBackup(createdAt));
      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn btn-danger btn-sm';
      btnDelete.type = 'button';
      btnDelete.textContent = '删除';
      btnDelete.addEventListener('click', () => this.deleteAutoBackup(createdAt));
      actions.append(btnRestore, btnDelete);
      row.append(head, meta, actions);
      this.autoBackupList.appendChild(row);
    }
  }

  async restoreAutoBackup(createdAt) {
    if (!window.confirm('将把该快照中的收纳组写回，不删除现有其他组。确定恢复？')) return;
    const res = await MessageBus.sendToBackground(ActionTypes.RESTORE_AUTO_BACKUP, {
      createdAt,
      confirm: true
    });
    const data = res?.data || {};
    const ok = res?.success && data.success !== false;
    Toast.show(ok ? `已恢复 ${data.groupCount ?? ''} 个收纳组`.trim() : (data.error || res?.error || '恢复失败'));
    if (ok) this.onDataRestored?.();
    await this.loadAutoBackups();
  }

  async deleteAutoBackup(createdAt) {
    if (!window.confirm('确定删除该自动快照？此操作不可撤销。')) return;
    const res = await MessageBus.sendToBackground(ActionTypes.DELETE_AUTO_BACKUP, {
      createdAt,
      confirm: true
    });
    const data = res?.data || {};
    Toast.show(res?.success && data.success !== false ? '已删除该快照' : (data.error || res?.error || '删除失败'));
    await this.loadAutoBackups();
  }

  async executeRestoreJSON(backupData) {
    if (!backupData || typeof backupData !== 'object') {
      Toast.show('备份数据无效');
      return;
    }
    const res = await MessageBus.sendToBackground(ActionTypes.RESTORE_FULL_BACKUP, {
      jsonString: JSON.stringify(backupData)
    });
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
    const res = await MessageBus.sendToBackground(ActionTypes.IMPORT_THIRD_PARTY_DATA, { textString: rawText });
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
 * 云端同步 (WebDAV) 组件：凭据、连接探测、状态、冲突裁决与设备管理
 */
class WebdavSyncComponent {
  constructor() {
    this.$serverUrl = document.getElementById('webdavServerUrl');
    this.$username = document.getElementById('webdavUsername');
    this.$password = document.getElementById('webdavPassword');
    this.$enabled = document.getElementById('chkWebdavEnabled');
    this.$autoSync = document.getElementById('chkWebdavAutoSync');
    this.$accountConfigSync = document.getElementById('chkAccountConfigSync');
    this.$btnSave = document.getElementById('btnWebdavSave');
    this.$btnTest = document.getElementById('btnWebdavTest');
    this.$btnSyncNow = document.getElementById('btnSyncNow');
    this.$statusDot = document.getElementById('syncStatusDot');
    this.$statusBadge = document.getElementById('syncStatusBadge');
    this.$statusMessage = document.getElementById('syncStatusMessage');
    this.$deviceId = document.getElementById('syncDeviceId');
    this.$pendingCount = document.getElementById('syncPendingCount');
    this.$conflictCount = document.getElementById('syncConflictCount');
    this.$lastAt = document.getElementById('syncLastAt');
    this.$conflictsList = document.getElementById('syncConflictsList');
    this.$devicesList = document.getElementById('syncDevicesList');
    this.$recoveryMessage = document.getElementById('syncRecoveryMessage');
    this.$btnFallbackSnapshot = document.getElementById('btnSyncFallbackSnapshot');
    this.$btnRebuildFromScratch = document.getElementById('btnSyncRebuildFromScratch');
    this.init();
  }

  init() {
    this.$btnSave?.addEventListener('click', () => this.saveCredentials());
    this.$btnTest?.addEventListener('click', () => this.testConnection());
    this.$btnSyncNow?.addEventListener('click', () => this.syncNow());
    this.$enabled?.addEventListener('change', () => this.saveCredentials());
    this.$autoSync?.addEventListener('change', () => this.saveCredentials());
    this.$accountConfigSync?.addEventListener('change', () => this.saveAccountConfigSync());
    this.$btnFallbackSnapshot?.addEventListener('click', () => this.fallbackPreviousSnapshot());
    this.$btnRebuildFromScratch?.addEventListener('click', () => this.rebuildFromScratch());
    this.loadAll();
  }

  async loadAll() {
    await Promise.all([
      this.loadStatus(),
      this.loadConflicts(),
      this.loadDevices()
    ]);
  }

  async loadStatus() {
    await this.loadAccountConfigSync();
    const res = await MessageBus.sendToBackground(ActionTypes.GET_SYNC_STATUS);
    const status = res?.success && res.data ? res.data : {};
    if (!res?.success || !res.data) {
      await this.loadRecoveryInfo(status);
      return;
    }
    if (this.$serverUrl && !this.$serverUrl.value) this.$serverUrl.value = status.serverUrl || '';
    if (this.$username && !this.$username.value) this.$username.value = status.username || '';
    if (this.$enabled) this.$enabled.checked = status.enabled === true;
    if (this.$autoSync) this.$autoSync.checked = status.autoSync !== false;
    if (this.$deviceId) this.$deviceId.textContent = status.deviceId || '-';
    if (this.$pendingCount) this.$pendingCount.textContent = String(status.pendingCount ?? 0);
    if (this.$conflictCount) this.$conflictCount.textContent = String(status.conflictCount ?? 0);
    if (this.$lastAt) {
      this.$lastAt.textContent = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('zh-CN') : '-';
    }
    const labelMap = {
      synced: '已同步',
      pending: '离线待上传',
      auth_failed: '认证失败',
      capability_missing: '服务器能力不足',
      conflict: '条件写入冲突',
      corrupt: '数据损坏',
      unknown: '未知错误',
      idle: '尚未同步'
    };
    if (this.$statusBadge) this.$statusBadge.textContent = labelMap[status.status] || '尚未同步';
    if (this.$statusDot) this.$statusDot.dataset.status = status.status || 'idle';
    if (this.$statusMessage) this.$statusMessage.textContent = status.message || '';
    await this.loadRecoveryInfo(status);
  }

  async loadAccountConfigSync() {
    const configRes = await MessageBus.sendToBackground(ActionTypes.GET_CONFIG);
    if (!this.$accountConfigSync || !configRes?.success || !configRes.data) return;
    this.$accountConfigSync.checked = configRes.data.accountConfigSync?.enabled !== false;
  }

  async saveAccountConfigSync() {
    const enabled = this.$accountConfigSync?.checked !== false;
    const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
      accountConfigSync: { enabled }
    });
    Toast.show(res?.success ? (enabled ? '已开启浏览器账号偏好同步' : '已关闭浏览器账号偏好同步') : (res?.error || '保存失败'));
  }

  async saveCredentials() {
    const payload = {
      serverUrl: this.$serverUrl?.value.trim() || '',
      username: this.$username?.value.trim() || '',
      enabled: this.$enabled?.checked === true,
      autoSync: this.$autoSync?.checked !== false
    };
    const password = this.$password?.value || '';
    if (password) payload.password = password;
    const res = await MessageBus.sendToBackground(ActionTypes.SAVE_WEBDAV_CREDENTIALS, payload);
    if (!res?.success) {
      Toast.show(res?.error || '保存失败');
      return;
    }
    this.$password.value = '';
    Toast.show('WebDAV 凭据已保存到本机');
    await this.loadStatus();
  }

  async testConnection() {
    Toast.show('正在探测服务器 ETag 条件写入能力…');
    const res = await MessageBus.sendToBackground(ActionTypes.TEST_WEBDAV_CONNECTION);
    // 消息总线会把处理器返回值包装为 { success, data }，真实结果在 data 内
    const data = res?.data || {};
    if (res?.success && data.success !== false) {
      Toast.show(data.message || '连接与条件写入探测通过');
    } else {
      Toast.show(data.error || res?.error || '连接失败');
    }
    await this.loadStatus();
  }

  async syncNow() {
    Toast.show('正在同步…');
    const res = await MessageBus.sendToBackground(ActionTypes.RUN_SYNC_NOW);
    // 消息总线会把处理器返回值包装为 { success, data }，真实结果在 data 内
    const data = res?.data || {};
    if (res?.success && data.success !== false) {
      Toast.show(data.pendingCount > 0
        ? `同步完成（待上传 ${data.pendingCount} 条）`
        : '同步完成，云端已是最新');
    } else {
      Toast.show(data.error || res?.error || '同步失败');
    }
    await this.loadAll();
  }

  async loadConflicts() {
    const res = await MessageBus.sendToBackground(ActionTypes.LIST_SYNC_CONFLICTS);
    const conflicts = res?.success && Array.isArray(res.data) ? res.data : [];
    if (!this.$conflictsList) return;
    if (conflicts.length === 0) {
      this.$conflictsList.innerHTML = '<p class="sync-empty">当前没有待裁决的冲突 🎉</p>';
      return;
    }
    this.$conflictsList.innerHTML = '';
    for (const conflict of conflicts) {
      const item = document.createElement('div');
      item.className = 'conflict-item';
      const head = document.createElement('div');
      head.className = 'conflict-head';
      head.textContent = `${conflict.entityType} · ${conflict.field}`;
      const values = document.createElement('div');
      values.className = 'conflict-values';
      const local = document.createElement('code');
      local.textContent = `本机：${this._preview(conflict.localValue)}`;
      const incoming = document.createElement('code');
      incoming.textContent = `云端：${this._preview(conflict.incomingValue)}`;
      values.append(local, incoming);
      const actions = document.createElement('div');
      actions.className = 'btn-group';
      const keepLocal = document.createElement('button');
      keepLocal.className = 'btn btn-secondary btn-sm';
      keepLocal.type = 'button';
      keepLocal.textContent = '保留本机值';
      keepLocal.addEventListener('click', () => this.resolveConflict(conflict.conflictId, 'local'));
      const useCloud = document.createElement('button');
      useCloud.className = 'btn btn-primary btn-sm';
      useCloud.type = 'button';
      useCloud.textContent = '采用云端值';
      useCloud.addEventListener('click', () => this.resolveConflict(conflict.conflictId, 'incoming'));
      actions.append(keepLocal, useCloud);
      item.append(head, values, actions);
      this.$conflictsList.appendChild(item);
    }
  }

  _preview(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const plain = String(text ?? '');
    return plain.length > 60 ? `${plain.slice(0, 60)}…` : plain;
  }

  async resolveConflict(conflictId, choice) {
    const res = await MessageBus.sendToBackground(ActionTypes.RESOLVE_SYNC_CONFLICT, { conflictId, choice });
    const data = res?.data || {};
    Toast.show(res?.success && data.success !== false ? '已裁决并写入同步队列' : (data.error || res?.error || '裁决失败'));
    await this.loadAll();
  }

  async loadDevices() {
    const res = await MessageBus.sendToBackground(ActionTypes.LIST_SYNC_DEVICES);
    const devices = res?.success && Array.isArray(res.data) ? res.data : [];
    if (!this.$devicesList) return;
    if (devices.length === 0) {
      this.$devicesList.innerHTML = '<p class="sync-empty">尚未获取设备列表（首次同步后出现）</p>';
      return;
    }
    this.$devicesList.innerHTML = '';
    for (const device of devices) {
      const item = document.createElement('div');
      item.className = 'device-item';
      const info = document.createElement('div');
      info.className = 'device-info';
      const name = document.createElement('span');
      name.textContent = `${device.isSelf ? '本机' : '设备'} · ${String(device.deviceId).slice(0, 18)}…`;
      const meta = document.createElement('span');
      meta.className = 'device-meta';
      meta.textContent = [
        device.retired ? '已退役' : '活跃',
        device.lastSeenAt ? `最近同步 ${new Date(device.lastSeenAt).toLocaleString('zh-CN')}` : ''
      ].filter(Boolean).join(' · ');
      info.append(name, meta);
      const actions = document.createElement('div');
      actions.className = 'btn-group';
      if (!device.retired && !device.isSelf) {
        const retireBtn = document.createElement('button');
        retireBtn.className = 'btn btn-danger btn-sm';
        retireBtn.type = 'button';
        retireBtn.textContent = '退役';
        retireBtn.addEventListener('click', () => this.retireDevice(device.deviceId));
        actions.appendChild(retireBtn);
      }
      item.append(info, actions);
      this.$devicesList.appendChild(item);
    }
  }

  async retireDevice(deviceId) {
    if (!window.confirm('确定将该设备退役吗？退役设备回归时将从最新快照重新配对。')) return;
    const res = await MessageBus.sendToBackground(ActionTypes.RETIRE_SYNC_DEVICE, { deviceId });
    const data = res?.data || {};
    Toast.show(res?.success && data.success !== false ? '设备已退役' : (data.error || res?.error || '操作失败'));
    await this.loadDevices();
  }

  async loadRecoveryInfo(statusHint) {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_SYNC_RECOVERY_INFO);
    const info = res?.success && res.data && typeof res.data === 'object' ? res.data : {};
    const status = statusHint?.status || info.status || '';
    const isCorrupt = status === 'corrupt' || info.corrupt === true;
    const hasLocalSnapshot = info.hasLocalSnapshot === true;
    const enableActions = isCorrupt || hasLocalSnapshot;

    if (this.$recoveryMessage) {
      if (isCorrupt) {
        this.$recoveryMessage.textContent = info.message || statusHint?.message || '远端数据损坏，可回退上一份快照或从本机快照重建。';
      } else if (hasLocalSnapshot) {
        this.$recoveryMessage.textContent = '当前同步正常。本机有可用快照，损坏时可用于重建。';
      } else {
        this.$recoveryMessage.textContent = '当前同步正常。损坏时将在此启用恢复操作。';
      }
    }
    if (this.$btnFallbackSnapshot) this.$btnFallbackSnapshot.disabled = !enableActions;
    if (this.$btnRebuildFromScratch) this.$btnRebuildFromScratch.disabled = !enableActions;
  }

  async fallbackPreviousSnapshot() {
    const res = await MessageBus.sendToBackground(ActionTypes.FALLBACK_PREVIOUS_SNAPSHOT);
    const data = res?.data || {};
    Toast.show(res?.success && data.success !== false ? (data.message || '已回退上一份快照') : (data.error || res?.error || '回退失败'));
    await this.loadAll();
  }

  async rebuildFromScratch() {
    if (!window.confirm('危险：将用本机快照从头重建云端同步状态，可能覆盖远端损坏数据。确定继续？')) return;
    const res = await MessageBus.sendToBackground(ActionTypes.REBUILD_SYNC_FROM_SCRATCH, { confirm: true });
    const data = res?.data || {};
    Toast.show(res?.success && data.success !== false ? (data.message || '已从本机快照重建') : (data.error || res?.error || '重建失败'));
    await this.loadAll();
  }
}

/**
 * AI 桥接组件 (AIBridgeComponent)
 * 桥接开关 / 连接状态 / 扩展 ID 复制（操作审计统一在运行日志页查看）
 */
class AIBridgeComponent {
  constructor() {
    this.$enabled = document.getElementById('chkAiBridgeEnabled');
    this.$statusDot = document.getElementById('aiBridgeStatusDot');
    this.$statusBadge = document.getElementById('aiBridgeStatusBadge');
    this.$statusMessage = document.getElementById('aiBridgeStatusMessage');
    this.$extensionId = document.getElementById('aiBridgeExtensionId');
    this.$proto = document.getElementById('aiBridgeApiVersion');
    this.$btnCopyId = document.getElementById('btnAiBridgeCopyId');
    this.$btnRefresh = document.getElementById('btnAiBridgeRefresh');
    this.init();
  }

  init() {
    this.$enabled?.addEventListener('change', () => this.saveEnabled());
    this.$btnCopyId?.addEventListener('click', () => this.copyExtensionId());
    this.$btnRefresh?.addEventListener('click', () => this.loadAll());
    this.loadAll();
  }

  async loadAll() {
    await Promise.all([this.loadConfig(), this.loadStatus()]);
  }

  async loadConfig() {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_CONFIG);
    if (this.$enabled && res?.success && res.data) {
      this.$enabled.checked = res.data.aiBridge?.enabled === true;
    }
  }

  async loadStatus() {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_AI_BRIDGE_STATUS);
    if (!res?.success || !res.data) return;
    const status = res.data;

    const stateLabelMap = {
      disabled: '未启用',
      connecting: '暂无连接',
      connected: 'AI Agent 已连接',
      incompatible: 'API 版本不兼容',
      reconnecting: 'AI Agent 连接中断，重连中…',
      host_missing: '暂无 AI Agent 连接',
      error: '连接异常',
      unsupported: '当前环境不支持'
    };
    const dotStatusMap = {
      connected: 'synced',
      connecting: 'pending',
      incompatible: 'auth_failed',
      reconnecting: 'pending',
      host_missing: 'auth_failed',
      error: 'auth_failed',
      unsupported: 'auth_failed',
      disabled: 'idle'
    };
    if (this.$statusBadge) this.$statusBadge.textContent = stateLabelMap[status.state] || '未启用';
    if (this.$statusDot) this.$statusDot.dataset.status = dotStatusMap[status.state] || 'idle';
    if (this.$statusMessage) {
      this.$statusMessage.textContent = status.state === 'host_missing'
        ? '请先执行 deno task ai-host-install 安装本机 AI Agent（扩展 ID 见下方）'
        : (status.lastError || '');
    }
    if (this.$extensionId) this.$extensionId.textContent = status.extensionId || chrome.runtime.id || '-';
    if (this.$proto) this.$proto.textContent = String(status.apiVersion ?? '-');
  }

  async saveEnabled() {
    const enabled = this.$enabled?.checked === true;
    const res = await MessageBus.sendToBackground(ActionTypes.UPDATE_CONFIG, {
      aiBridge: { enabled }
    });
    Toast.show(res?.success
      ? (enabled ? 'AI 桥接已开启，本机 AI Agent 将按需连接' : 'AI 桥接已关闭，本机通道已断开')
      : (res?.error || '保存失败'));
    await this.loadStatus();
  }

  async copyExtensionId() {
    const res = await MessageBus.sendToBackground(ActionTypes.GET_AI_BRIDGE_STATUS);
    const extensionId = res?.data?.extensionId || chrome.runtime.id || '';
    if (!extensionId) {
      Toast.show('无法获取扩展 ID');
      return;
    }
    try {
      await navigator.clipboard.writeText(extensionId);
      Toast.show('扩展 ID 已复制，安装 AI Agent 时使用 --ext-id 参数传入');
    } catch {
      Toast.show('复制失败，请手动选择并复制');
    }
  }
}

class RuntimeLogComponent {
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
class AboutComponent {
  constructor() {
    this.$softwareVersion = document.getElementById('aboutSoftwareVersion');
    this.$releaseMilestone = document.getElementById('aboutReleaseMilestone');
    this.$apiVersion = document.getElementById('aboutApiVersion');
    this.$dataRevision = document.getElementById('aboutDataRevision');
    this.$extensionId = document.getElementById('aboutExtensionId');
    this.$btnCopyVersion = document.getElementById('btnCopyVersionInfo');

    this.init();
  }

  init() {
    this.render();
    this.bindEvents();
  }

  render() {
    const manifest = chrome.runtime.getManifest?.() || {};
    const softwareVersion = manifest.version || '1.0.0';
    const versionName = manifest.version_name || softwareVersion;
    const extensionId = chrome.runtime?.id || '-';

    if (this.$softwareVersion) {
      this.$softwareVersion.textContent = versionName ? `${softwareVersion} (${versionName})` : softwareVersion;
    }
    if (this.$releaseMilestone) {
      this.$releaseMilestone.textContent = versionName || `v${softwareVersion}`;
    }
    if (this.$apiVersion) {
      this.$apiVersion.textContent = String(API_VERSION);
    }
    if (this.$dataRevision) {
      this.$dataRevision.textContent = String(LOCAL_DATA_SCHEMA_REVISION ?? 8);
    }
    if (this.$extensionId) {
      this.$extensionId.textContent = extensionId;
    }
  }

  bindEvents() {
    this.$btnCopyVersion?.addEventListener('click', async () => {
      const manifest = chrome.runtime.getManifest?.() || {};
      const softwareVersion = manifest.version || '1.0.0';
      const versionName = manifest.version_name || softwareVersion;
      const extensionId = chrome.runtime?.id || '-';
      const userAgent = navigator.userAgent || '';

      const diagnosticText = [
        `BetterBrowse 诊断信息`,
        `--------------------`,
        `软件版本: ${softwareVersion} (${versionName})`,
        `API 版本: ${API_VERSION}`,
        `数据结构版本: ${LOCAL_DATA_SCHEMA_REVISION ?? 8}`,
        `扩展 ID: ${extensionId}`,
        `User Agent: ${userAgent}`,
        `当前时间: ${new Date().toISOString()}`
      ].join('\n');

      try {
        await navigator.clipboard.writeText(diagnosticText);
        Toast.show('版本诊断信息已复制到剪贴板');
      } catch {
        Toast.show('复制失败，请手动选择并复制');
      }
    });
  }
}

/**
 * 搜索主页组件 (Capybara 风格)
 *
 * 迁移自 capybera/search-engine 的视觉布局与基础交互。只保留搜索引擎切换、
 * 搜索提交（在新标签页打开所选引擎）与快捷链接三块用户可见能力；不迁移
 * SearXNG 本地代理与结果渲染（依赖独立 Node 服务器，不适合直接搬进扩展）。
 */
class SearchHomeComponent {
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
    this.bindEvents();
  }

  bindEvents() {
    // 切换搜索引擎
    this.engineBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.engineBtns.forEach((b) => b.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
        this.currentEngine = btn.dataset.engine;
        this.searchInput?.focus();
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

/**
 * 设置子分类标题对照表
 */
const SETTINGS_SUBTAB_TITLES = {
  'stash-settings': '收纳箱设置',
  'rules': '智能收纳规则',
  'links': '域名跳转规则',
  'backup': '数据备份与迁移',
  'sync': '云端同步',
  'ai-bridge': 'AI 桥接',
  'logs': '运行日志',
  'about': '关于'
};
const SETTINGS_SUBTABS = Object.keys(SETTINGS_SUBTAB_TITLES);

/**
 * 仪表盘总协调应用 (OptionsApp)
 */
class OptionsApp {
  constructor() {
    this.tabStash = document.getElementById('tab-stash');
    this.tabSearch = document.getElementById('tab-search');
    this.viewSettingsHub = document.getElementById('view-settings-hub');
    this.btnSidebarSettings = document.getElementById('btnSidebarSettings');
    this.btnBackToStash = document.getElementById('btnBackToStash');
    this.navItemStash = document.getElementById('navTabStash');
    this.navItemSearch = document.getElementById('navTabSearch');
    this.subnavItems = document.querySelectorAll('.settings-subnav-item');
    this.breadcrumbCurrent = document.getElementById('settingsCurrentSubtabBreadcrumb');
    this.panels = document.querySelectorAll('.tab-panel');

    this.currentSettingsSubtab = 'stash-settings';

    this.init();
  }

  init() {
    this.components = new Map();
    this.componentFactories = {
      'stash-settings': () => new StashSettingsComponent(),
      rules: () => new RulesConfigComponent(),
      links: () => new DomainRulesComponent(),
      sync: () => new WebdavSyncComponent(),
      'ai-bridge': () => new AIBridgeComponent(),
      logs: () => new RuntimeLogComponent(),
      about: () => new AboutComponent(),
      backup: () => new BackupComponent(() => {
        this.components.get('stash')?.loadData?.();
        this.components.get('stash-settings')?.loadSettings?.();
        this.components.get('rules')?.loadConfig?.();
        this.components.get('links')?.loadRules?.();
      })
    };
    this.components.set('stash', new StashTabComponent());
    this.components.set('search', new SearchHomeComponent());
    this.bindNavigation();

    // 接收来自后台的主动通知；尚未打开的面板不提前实例化，首次进入时读取最新状态。
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.action) return false;
      if (message.action === 'SWITCH_OPTIONS_TAB' && message.payload?.tab) {
        this.switchTab(message.payload.tab);
      } else if (message.action === ActionTypes.OPEN_OPTIONS_PAGE && message.payload?.tab) {
        this.switchTab(message.payload.tab);
      } else if (message.action === ActionTypes.NOTIFY_STASH_UPDATED) {
        this.components.get('stash')?.loadData?.();
      } else if (message.action === ActionTypes.NOTIFY_RULE_UPDATED) {
        this.components.get('links')?.loadRules?.();
      } else if (message.action === ActionTypes.NOTIFY_CONFIG_UPDATED) {
        this.components.get('stash-settings')?.loadSettings?.();
        this.components.get('rules')?.loadConfig?.();
        this.components.get('sync')?.loadAccountConfigSync?.();
        this.components.get('ai-bridge')?.loadConfig?.();
      } else if (message.action === ActionTypes.NOTIFY_SYNC_UPDATED) {
        this.components.get('sync')?.loadAll?.();
      }
      return false;
    });

    window.addEventListener('hashchange', () => {
      const rawHash = window.location.hash.replace(/^#/, '');
      if (rawHash) this.switchTab(rawHash, false);
    });

    const rawHash = window.location.hash.replace(/^#/, '');
    this.switchTab(rawHash || 'stash', false);
  }

  ensureComponent(tabName) {
    if (!tabName || tabName === 'stash') return this.components.get('stash');
    if (this.components.has(tabName)) return this.components.get(tabName);
    const factory = this.componentFactories[tabName];
    if (!factory) return null;
    const component = factory();
    this.components.set(tabName, component);
    if (tabName === 'logs') this.runtimeLogComponent = component;
    CustomSelectEnhancer.enhanceAll(document.getElementById(`tab-${tabName}`) || document);
    return component;
  }

  bindNavigation() {
    // 侧边栏时间线按钮点击
    this.navItemStash?.addEventListener('click', () => {
      this.switchTab('stash');
    });

    // 侧边栏搜索主页按钮点击
    this.navItemSearch?.addEventListener('click', () => {
      this.switchTab('search');
    });

    // 侧边栏左下角系统设置按钮点击（进入统一设置中心）
    this.btnSidebarSettings?.addEventListener('click', () => {
      this.switchTab(this.currentSettingsSubtab || 'stash-settings');
    });

    // 设置中心顶部「返回时间线」按钮点击
    this.btnBackToStash?.addEventListener('click', () => {
      this.switchTab('stash');
    });

    // 设置中心二级子分类导航 Tab 点击
    this.subnavItems.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetSubtab = btn.getAttribute('data-subtab');
        if (targetSubtab) {
          this.switchTab(targetSubtab);
        }
      });
    });

    // 键盘 Esc 快捷键：当处于设置页面时快速退回时间线
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.viewSettingsHub && !this.viewSettingsHub.hidden) {
        const isEditingInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
        if (!isEditingInput) {
          this.switchTab('stash');
        }
      }
    });
  }

  /**
   * 统一切换视图与设置选项
   * @param {string} tabName 目标标签名 ('stash' | 'search' | 'settings' | 'stash-settings' | 'rules' | 'links' | 'backup' | 'sync' | 'ai-bridge' | 'logs')
   * @param {boolean} [updateHash=true] 是否同步更新 URL Hash
   */
  switchTab(tabName, updateHash = true) {
    if (!tabName) tabName = 'stash';

    const isStashView = tabName === 'stash';
    const isSearchView = tabName === 'search';
    const isSettingsSubtab = SETTINGS_SUBTABS.includes(tabName);
    const targetSubtab = isSettingsSubtab ? tabName : (tabName === 'settings' ? this.currentSettingsSubtab : null);

    if (isStashView) {
      // 1. 激活时间线主视图
      if (this.tabStash) {
        this.tabStash.classList.add('active');
        this.tabStash.hidden = false;
      }
      if (this.tabSearch) {
        this.tabSearch.classList.remove('active');
        this.tabSearch.hidden = true;
      }
      if (this.viewSettingsHub) {
        this.viewSettingsHub.classList.remove('active');
        this.viewSettingsHub.hidden = true;
      }

      // 2. 侧边栏按钮状态同步
      this.navItemStash?.classList.add('active');
      this.navItemStash?.setAttribute('aria-selected', 'true');
      this.navItemStash?.setAttribute('tabindex', '0');

      this.navItemSearch?.classList.remove('active');
      this.navItemSearch?.setAttribute('aria-selected', 'false');
      this.navItemSearch?.setAttribute('tabindex', '-1');

      this.btnSidebarSettings?.classList.remove('active');
      this.btnSidebarSettings?.setAttribute('aria-selected', 'false');

      if (updateHash) {
        try {
          history.replaceState(null, '', '#stash');
        } catch {
          // 忽略历史记录异常
        }
      }
      return;
    }

    if (isSearchView) {
      // 1. 激活搜索主视图、隐藏时间线与设置中心
      if (this.tabSearch) {
        this.tabSearch.classList.add('active');
        this.tabSearch.hidden = false;
      }
      if (this.tabStash) {
        this.tabStash.classList.remove('active');
        this.tabStash.hidden = true;
      }
      if (this.viewSettingsHub) {
        this.viewSettingsHub.classList.remove('active');
        this.viewSettingsHub.hidden = true;
      }

      // 2. 侧边栏按钮状态同步
      this.navItemStash?.classList.remove('active');
      this.navItemStash?.setAttribute('aria-selected', 'false');
      this.navItemStash?.setAttribute('tabindex', '-1');

      this.navItemSearch?.classList.add('active');
      this.navItemSearch?.setAttribute('aria-selected', 'true');
      this.navItemSearch?.setAttribute('tabindex', '0');

      this.btnSidebarSettings?.classList.remove('active');
      this.btnSidebarSettings?.setAttribute('aria-selected', 'false');

      // 3. 进入时聚焦搜索框，便于直接输入
      this.components.get('search')?.activate?.();

      if (updateHash) {
        try {
          history.replaceState(null, '', '#search');
        } catch {
          // 忽略历史记录异常
        }
      }
      return;
    }

    // 进入设置中心前，先隐藏搜索主视图
    if (this.tabSearch) {
      this.tabSearch.classList.remove('active');
      this.tabSearch.hidden = true;
    }
    this.navItemSearch?.classList.remove('active');
    this.navItemSearch?.setAttribute('aria-selected', 'false');
    this.navItemSearch?.setAttribute('tabindex', '-1');

    if (targetSubtab) {
      // 进入面板时才实例化并读取数据，避免打开时间线就加载全部隐藏设置页。
      const targetComponent = this.ensureComponent(targetSubtab);
      this.currentSettingsSubtab = targetSubtab;

      if (this.tabStash) {
        this.tabStash.classList.remove('active');
        this.tabStash.hidden = true;
      }
      if (this.viewSettingsHub) {
        this.viewSettingsHub.classList.add('active');
        this.viewSettingsHub.hidden = false;
      }

      // 2. 侧边栏按钮状态同步
      this.navItemStash?.classList.remove('active');
      this.navItemStash?.setAttribute('aria-selected', 'false');
      this.navItemStash?.setAttribute('tabindex', '-1');

      this.btnSidebarSettings?.classList.add('active');
      this.btnSidebarSettings?.setAttribute('aria-selected', 'true');

      // 3. 二级导航 Tab 与面包屑同步
      this.subnavItems.forEach((item) => {
        const isCurrent = item.getAttribute('data-subtab') === targetSubtab;
        item.classList.toggle('active', isCurrent);
        item.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
        item.tabIndex = isCurrent ? 0 : -1;
      });

      if (this.breadcrumbCurrent) {
        this.breadcrumbCurrent.textContent = SETTINGS_SUBTAB_TITLES[targetSubtab] || '设置';
      }

      // 4. 激活对应设置子面板
      this.panels.forEach((panel) => {
        if (panel.id === `tab-${targetSubtab}`) {
          panel.classList.add('active');
          panel.hidden = false;
        } else if (panel.id !== 'tab-stash') {
          panel.classList.remove('active');
          panel.hidden = true;
        }
      });

      // 日志列表需要在面板可见后读取高度并渲染。
      if (targetSubtab === 'logs') {
        targetComponent?.load?.();
      }

      if (updateHash) {
        try {
          history.replaceState(null, '', `#${targetSubtab}`);
        } catch {
          // 忽略历史记录异常
        }
      }
    }
  }
}

// 启动管理中心应用
document.addEventListener('DOMContentLoaded', () => {
  const versionTag = document.getElementById('softwareVersionTag');
  const manifest = chrome.runtime.getManifest?.() || {};
  const softwareVersion = manifest.version_name || manifest.version || '-';
  if (versionTag) versionTag.textContent = `BetterBrowse · ${softwareVersion}`;
  new OptionsApp();
  CustomSelectEnhancer.enhanceAll();
});
