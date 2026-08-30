/**
 * @file popup.js
 * @description 弹出控制台视图控制器（分段滑动胶囊选择器 + 键盘无障碍 + 丝滑吸附微交互）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { LinkModes } from '../constants/config.js';
import { LinkMatcher } from '../core/link/link-matcher.js';
import { MessageBus } from '../core/bus/message-bus.js';

// 模式配置与档位索引 (0: 当前标签 | 1: 自动模式 | 2: 新标签页)
const MODES_CONFIG = [
  { mode: LinkModes.CURRENT, index: 0, label: '当前标签打开' },
  { mode: LinkModes.AUTO, index: 1, label: '自动模式（不干涉）' },
  { mode: LinkModes.NEW, index: 2, label: '新标签页打开' }
];

class PopupController {
  constructor() {
    this.currentTab = null;
    this.currentDomain = '';
    this.currentMode = LinkModes.AUTO;
    this.isSpecialPage = false;
    this.isGlobalApplied = false;
    this.statusTimer = null;
    this.countdownPollTimer = null;

    // DOM 元素引用缓存
    this.dom = {
      domainBadge: document.getElementById('domainBadge'),
      segmentedControl: document.getElementById('segmentedControl'),
      segmentedIndicator: document.getElementById('segmentedIndicator'),
      segmentedItems: document.querySelectorAll('.segmented-item'),
      tabCounterContainer: document.getElementById('tabCounterContainer'),
      tabCountText: document.getElementById('tabCountText'),
      btnExecuteStash: document.getElementById('btnExecuteStash'),
      btnExecuteStashText: document.getElementById('btnExecuteStashText'),
      btnViewStash: document.getElementById('btnViewStash'),
      btnOpenOptions: document.getElementById('btnOpenOptions'),
      statusDot: document.getElementById('statusDot'),
      statusMessage: document.getElementById('statusMessage')
    };

    this.init();
  }

  async init() {
    this.bindSegmentedEvents();
    this.bindActionEvents();
    window.addEventListener('unload', () => {
      if (this.countdownPollTimer) clearInterval(this.countdownPollTimer);
    });
    await this.loadActiveTabInfo();
    await this.loadLinkRuleState();
    await this.loadTabCountInfo();
  }

  /**
   * 绑定分段滑动胶囊控制器点击与无障碍键盘导航交互
   */
  bindSegmentedEvents() {
    // 1. 点击切换
    this.dom.segmentedItems.forEach((itemEl) => {
      itemEl.addEventListener('click', () => {
        if (this.isSpecialPage) return;
        const targetMode = itemEl.dataset.mode;
        if (targetMode && targetMode !== this.currentMode) {
          this.handleModeChange(targetMode);
        }
      });

      // 2. 键盘导航 (WAI-ARIA Radio Group 模式：ArrowLeft, ArrowRight, Home, End)
      itemEl.addEventListener('keydown', (e) => {
        if (this.isSpecialPage) return;
        const currentIndex = MODES_CONFIG.findIndex((c) => c.mode === this.currentMode);
        let nextIndex = -1;

        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          nextIndex = (currentIndex + 1) % MODES_CONFIG.length;
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          nextIndex = (currentIndex - 1 + MODES_CONFIG.length) % MODES_CONFIG.length;
        } else if (e.key === 'Home') {
          e.preventDefault();
          nextIndex = 0;
        } else if (e.key === 'End') {
          e.preventDefault();
          nextIndex = MODES_CONFIG.length - 1;
        }

        if (nextIndex !== -1) {
          const nextConfig = MODES_CONFIG[nextIndex];
          this.handleModeChange(nextConfig.mode);
          const nextBtn = this.dom.segmentedItems[nextIndex];
          if (nextBtn) nextBtn.focus();
        }
      });
    });
  }

  bindActionEvents() {
    // 立即智能收纳
    this.dom.btnExecuteStash.addEventListener('click', () => {
      this.handleExecuteStash();
    });

    // 打开/激活第1位常驻固定收纳标签页
    this.dom.btnViewStash.addEventListener('click', () => {
      MessageBus.sendToBackground(ActionTypes.OPEN_PINNED_STASH_TAB);
    });

    // 打开选项设置页面
    this.dom.btnOpenOptions.addEventListener('click', () => {
      this.openOptionsPage();
    });
  }

  /**
   * 获取当前前台活跃标签页及其域名
   */
  async loadActiveTabInfo() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this.currentTab = tab;

      if (tab && tab.url) {
        this.currentDomain = LinkMatcher.extractDomain(tab.url);
        if (this.currentDomain) {
          this.isSpecialPage = false;
          this.dom.domainBadge.textContent = this.currentDomain;
          this.dom.domainBadge.title = `当前域名: ${this.currentDomain}`;
          this.dom.segmentedControl.classList.remove('disabled');
        } else {
          this.isSpecialPage = true;
          this.dom.domainBadge.textContent = '系统/特殊页面';
          this.dom.domainBadge.title = '浏览器内置页面或特殊协议，不支持配置独立跳转偏好';
          this.dom.segmentedControl.classList.add('disabled');
          this.showStatus('系统页面不支持自定义域名规则', 'info', 0);
        }
      } else {
        this.dom.domainBadge.textContent = '未知页面';
        this.isSpecialPage = true;
      }
    } catch (err) {
      console.warn('[Popup] 读取当前标签页失败:', err);
      this.isSpecialPage = true;
    }
  }

  /**
   * 加载当前域名的跳转模式并更新分段胶囊
   */
  async loadLinkRuleState() {
    if (this.isSpecialPage || !this.currentDomain) {
      this.updateSegmentedUI(LinkModes.AUTO);
      return;
    }

    const response = await MessageBus.sendToBackground(ActionTypes.GET_LINK_RULE, {
      domain: this.currentDomain
    });

    if (response.success && response.data) {
      const { domainRule, effectiveMode, isGlobalApplied } = response.data;
      this.isGlobalApplied = Boolean(isGlobalApplied);
      this.currentMode = effectiveMode || domainRule || LinkModes.AUTO;
      this.updateSegmentedUI(this.currentMode);

      if (this.isGlobalApplied) {
        this.showStatus('🌐 全局跳转规则生效中', 'info', 0);
      }
    } else {
      this.updateSegmentedUI(LinkModes.AUTO);
    }
  }

  /**
   * 加载当前标签页总数及阈值状态（支持实时倒计时感知）
   */
  async loadTabCountInfo() {
    const [countRes, countdownRes] = await Promise.all([
      MessageBus.sendToBackground(ActionTypes.GET_TAB_COUNT_INFO),
      MessageBus.sendToBackground(ActionTypes.GET_COUNTDOWN_STATUS)
    ]);

    if (countRes.success && countRes.data) {
      const { currentCount, threshold } = countRes.data;
      const countdown = countdownRes?.data;

      if (countdown && countdown.isCountingDown) {
        this.dom.tabCountText.textContent = `⏳ 倒计时: ${countdown.remainingSeconds}s (${currentCount}/${threshold})`;
        this.dom.tabCounterContainer.classList.add('warning');
        this.showStatus(`将在 ${countdown.remainingSeconds}s 后自动收纳闲置标签`, 'warning');
      } else {
        this.dom.tabCountText.textContent = `标签: ${currentCount} / ${threshold}`;
        if (currentCount >= threshold) {
          this.dom.tabCounterContainer.classList.add('warning');
          this.dom.tabCounterContainer.title = '标签页数量已达阈值，建议收纳';
        } else {
          this.dom.tabCounterContainer.classList.remove('warning');
          this.dom.tabCounterContainer.title = '当前窗口标签页数量及阈值';
        }
      }

      // 倒计时进行中每秒轮询刷新，保证 popup 打开期间状态实时；结束后自动停止
      const isCounting = Boolean(countdown && countdown.isCountingDown);
      if (isCounting && !this.countdownPollTimer) {
        this.countdownPollTimer = setInterval(() => {
          this.loadTabCountInfo();
        }, 1000);
      } else if (!isCounting && this.countdownPollTimer) {
        clearInterval(this.countdownPollTimer);
        this.countdownPollTimer = null;
      }
    }
  }

  /**
   * 处理模式切换
   * @param {'auto' | 'current' | 'new'} mode
   */
  async handleModeChange(mode) {
    if (this.isSpecialPage) return;

    this.currentMode = mode;
    this.updateSegmentedUI(mode);

    if (!this.currentDomain) {
      this.showStatus('特殊页面无法设置域名规则', 'warning');
      return;
    }

    const res = await MessageBus.sendToBackground(ActionTypes.SET_LINK_RULE, {
      domain: this.currentDomain,
      mode: mode
    });

    if (res.success) {
      // 直连当前标签页通知其立刻刷新内存模式（零延迟双重保障）
      if (this.currentTab && this.currentTab.id) {
        MessageBus.sendToTab(this.currentTab.id, ActionTypes.NOTIFY_RULE_UPDATED, {
          domain: this.currentDomain,
          mode: mode
        }, 800).catch(() => {});
      }

      const cfg = MODES_CONFIG.find((c) => c.mode === mode);
      const label = cfg ? cfg.label : mode;
      if (this.isGlobalApplied) {
        this.showStatus(`已保存偏好（全局规则生效中）`, 'success');
      } else {
        this.showStatus(`已设置 ${this.currentDomain} 为【${label}】`, 'success');
      }
    } else {
      this.showStatus('设置失败', 'error');
    }
  }

  /**
   * 更新分段控制器胶囊高亮位置与 WAI-ARIA 属性
   * @param {'auto' | 'current' | 'new'} mode
   */
  updateSegmentedUI(mode) {
    const activeConfig = MODES_CONFIG.find((c) => c.mode === mode) || MODES_CONFIG[1];
    const targetIndex = activeConfig.index;

    // 滑动胶囊指示器位置位移
    if (targetIndex === 0) {
      this.dom.segmentedIndicator.style.transform = 'translateX(0px)';
    } else if (targetIndex === 1) {
      this.dom.segmentedIndicator.style.transform = 'translateX(calc(100% + 2px))';
    } else {
      this.dom.segmentedIndicator.style.transform = 'translateX(calc(200% + 4px))';
    }

    // 更新按钮激活态与 ARIA 无障碍属性
    this.dom.segmentedItems.forEach((item) => {
      const isCurrent = item.dataset.mode === mode;
      if (isCurrent) {
        item.classList.add('active');
        item.setAttribute('aria-checked', 'true');
        item.setAttribute('tabindex', '0');
      } else {
        item.classList.remove('active');
        item.setAttribute('aria-checked', 'false');
        item.setAttribute('tabindex', '-1');
      }
    });
  }

  /**
   * 执行当前窗口全量标签收纳
   */
  async handleExecuteStash() {
    this.dom.btnExecuteStash.disabled = true;
    this.dom.btnExecuteStashText.textContent = '正在收纳...';
    this.showStatus('正在收纳当前窗口所有标签页...', 'info', 0);

    try {
      const res = await MessageBus.sendToBackground(ActionTypes.EXECUTE_STASH, { forceAll: true });
      if (res.success && res.data) {
        const { stashedCount } = res.data;
        if (stashedCount > 0) {
          this.showStatus(`已收纳 ${stashedCount} 个标签页至收纳箱`, 'success');
        } else {
          this.showStatus('当前窗口没有可收纳的网页', 'info');
        }
        await this.loadTabCountInfo();
      } else {
        this.showStatus(res.error || '收纳执行失败', 'error');
      }
    } catch (err) {
      this.showStatus('收纳请求异常', 'error');
    } finally {
      this.dom.btnExecuteStash.disabled = false;
      this.dom.btnExecuteStashText.textContent = '立即收纳当前窗口';
    }
  }

  /**
   * 展示底部状态通知（带自动淡出与颜色指示灯）
   * @param {string} message
   * @param {'info' | 'success' | 'warning' | 'error'} type
   * @param {number} autoResetMs
   */
  showStatus(message, type = 'info', autoResetMs = 3500) {
    clearTimeout(this.statusTimer);
    this.dom.statusMessage.textContent = message;

    this.dom.statusDot.className = 'status-dot';
    if (type === 'success') {
      this.dom.statusDot.classList.add('success');
      this.dom.statusMessage.style.color = 'var(--text-primary)';
    } else if (type === 'warning' || type === 'error') {
      this.dom.statusDot.classList.add(type);
      this.dom.statusMessage.style.color = 'var(--danger-color)';
    } else {
      this.dom.statusMessage.style.color = 'var(--text-muted)';
    }

    if (autoResetMs > 0) {
      this.statusTimer = setTimeout(() => {
        this.dom.statusMessage.textContent = '就绪';
        this.dom.statusMessage.style.color = 'var(--text-muted)';
        this.dom.statusDot.className = 'status-dot';
      }, autoResetMs);
    }
  }

  openOptionsPage() {
    MessageBus.sendToBackground(ActionTypes.OPEN_OPTIONS_PAGE, { tab: 'stash-settings' });
  }
}

// 页面加载完成后实例化控制器
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
