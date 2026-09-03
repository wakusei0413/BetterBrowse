/**
 * @file custom-select.js
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




export class CustomSelectEnhancer {
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
