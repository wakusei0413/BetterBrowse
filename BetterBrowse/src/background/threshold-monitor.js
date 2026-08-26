/**
 * @file threshold-monitor.js
 * @description 标签页数量阈值监控器（达到阈值时触发全场景 15 秒倒计时弹窗、Badge 动画与智能收纳）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';
import { StorageKeys } from '../constants/storage-keys.js';
import { filterCountableTabs } from '../core/extension-url.js';

export class ThresholdMonitor {
  /**
   * @param {Object} [options={}]
   * @param {(windowId?: number) => Promise<any>} [options.onStashRequested] - 触发智能收纳的回调函数
   * @param {() => Promise<any>} [options.onOpenOptions] - 打开选项页的回调函数
   */
  constructor({ onStashRequested = () => {}, onOpenOptions = () => {} } = {}) {
    this.onStashRequested = onStashRequested;
    this.onOpenOptions = onOpenOptions;
    this.notificationId = 'better_browse_threshold_notify';
    this.lastActionTime = 0; // 上次提醒、取消或执行收纳的时间戳（用于冷却防打扰）
    this.countdownInterval = null; // 兼容旧调用方，倒计时由 alarms 驱动
    this.remainingSeconds = 0; // 当前剩余秒数
    this.totalSeconds = 15;
    this.activeWindowId = null; // 当前正在倒计时的窗口 ID
    this.deadline = 0;
    this.alarmName = 'better-browse-threshold-countdown';

    this.initListeners();
    this.restoreState();

    // 插件启动或 Service Worker 唤醒时，延迟 1 秒主动检测一次当前窗口标签数
    setTimeout(() => {
      this.checkTabCount();
    }, 1000);
  }

  initListeners() {
    // 1. 监听新标签页创建
    chrome.tabs.onCreated.addListener(() => {
      this.checkTabCount();
    });

    // 2. 监听标签页切换激活
    chrome.tabs.onActivated.addListener(() => {
      this.checkTabCount();
    });

    // 3. 监听窗口获得焦点
    if (chrome.windows?.onFocusChanged) {
      chrome.windows.onFocusChanged.addListener((windowId) => {
        if (windowId !== chrome.windows.WINDOW_ID_NONE) {
          this.checkTabCount(windowId);
        }
      });
    }

    // 4. 监听通知按钮点击
    if (chrome.notifications && chrome.notifications.onButtonClicked) {
      chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
        if (notifId === this.notificationId) {
          if (btnIdx === 0) {
            this.handleConfirmAutoStash();
          } else if (btnIdx === 1 && this.onOpenOptions) {
            this.onOpenOptions();
          }
          chrome.notifications.clear(this.notificationId);
        }
      });
    }
    if (chrome.alarms?.onAlarm) {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm?.name === this.alarmName) this.handleAlarm();
      });
    }
  }

  async restoreState() {
    try {
      const state = await StorageAdapter.get(StorageKeys.THRESHOLD_STATE, null, 'session');
      if (!state || !state.deadline || state.deadline <= Date.now()) return;
      this.deadline = state.deadline;
      this.activeWindowId = state.activeWindowId ?? null;
      this.totalSeconds = state.totalSeconds || 15;
      this.lastActionTime = state.lastActionTime || 0;
      this.remainingSeconds = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
      this.updateBadge(this.remainingSeconds);
    } catch {}
  }

  async persistState() {
    await StorageAdapter.set(StorageKeys.THRESHOLD_STATE, {
      deadline: this.deadline,
      activeWindowId: this.activeWindowId,
      totalSeconds: this.totalSeconds,
      lastActionTime: this.lastActionTime
    }, 'session');
  }

  /**
   * 获取用户当前聚焦或操作的窗口及其所有标签页
   * @param {number} [targetWindowId]
   */
  async getActiveWindowInfo(targetWindowId = null) {
    try {
      if (typeof targetWindowId === 'number' && targetWindowId > 0) {
        const win = await chrome.windows.get(targetWindowId, { populate: true });
        if (win && win.tabs) {
          return { windowId: win.id, tabs: win.tabs };
        }
      }

      const lastWin = await chrome.windows.getLastFocused({
        populate: true,
        windowTypes: ['normal']
      });
      if (lastWin && lastWin.tabs && lastWin.tabs.length > 0) {
        return { windowId: lastWin.id, tabs: lastWin.tabs };
      }
    } catch {
      // 降级使用 chrome.tabs.query
    }

    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      if (tabs && tabs.length > 0) {
        return { windowId: tabs[0].windowId, tabs };
      }
    } catch {}

    return { windowId: null, tabs: [] };
  }

  /**
   * 检查当前窗口标签页数量是否超出阈值
   * @param {number} [targetWindowId]
   */
  async checkTabCount(targetWindowId = null) {
    try {
      const config = await StorageAdapter.getUserConfig();
      const { windowId, tabs } = await this.getActiveWindowInfo(targetWindowId);
      const countableTabs = filterCountableTabs(tabs);
      if (countableTabs.length === 0) {
        if (this.deadline > Date.now()) this.clearCountdownUI();
        return;
      }

      const currentCount = countableTabs.length;
      const threshold = config.tabThreshold || 15;

      if (currentCount < threshold) {
        // 若标签数已降回阈值以下且正在倒计时，取消倒计时
        if (this.deadline > Date.now()) {
          this.clearCountdownUI();
        }
        return;
      }

      const cooldownMinutes = config.thresholdCooldownMinutes || 5;
      const cooldownMs = cooldownMinutes * 60 * 1000;
      const now = Date.now();

      // 正在倒计时中或处于冷却期内，不重复打扰
      if (this.deadline > Date.now()) {
        return;
      }
      if (now - this.lastActionTime < cooldownMs) {
        return;
      }

      // 1. 若开启了超阈值自动倒计时智能收纳
      if (config.autoStashOnThreshold !== false) {
        this.lastActionTime = now;
        this.startCountdown(windowId, countableTabs, config);
        return;
      }

      // 2. 若仅开启了桌面通知提醒
      if (config.autoThresholdNotify) {
        this.lastActionTime = now;
        this.showThresholdNotification(currentCount, threshold);
      }
    } catch (err) {
      console.warn('[ThresholdMonitor] 检查标签页数量异常:', err);
    }
  }

  /**
   * 启动全场景 15 秒倒计时体系（包含 Badge 动画、前台网页卡片与系统通知）
   */
  startCountdown(windowId, tabs, config) {
    this.activeWindowId = windowId;
    this.totalSeconds = Math.max(3, config.countdownSeconds || 15);
    this.remainingSeconds = this.totalSeconds;
    const countableTabs = filterCountableTabs(tabs);
    const currentCount = countableTabs.length;
    const threshold = config.tabThreshold || 15;

    // 1. 更新 Action 图标 Badge 徽章动画
    this.updateBadge(this.remainingSeconds);

    // 2. 向当前窗口内所有可用的网页标签广播倒计时卡片
    this.broadcastBannerToTabs(countableTabs, {
      countdownSeconds: this.totalSeconds,
      currentCount,
      threshold
    });

    // 3. 弹出系统桌面通知备用
    if (config.autoThresholdNotify) {
      this.showThresholdNotification(currentCount, threshold, this.remainingSeconds);
    }

    this.deadline = Date.now() + this.totalSeconds * 1000;
    this.persistState();
    try {
      if (chrome.alarms?.create) {
        chrome.alarms.create(this.alarmName, { when: this.deadline });
      }
    } catch {}
  }

  async handleAlarm() {
    if (!this.deadline || this.deadline > Date.now()) return;
    const windowId = this.activeWindowId;
    this.clearCountdownUI();
    this.lastActionTime = Date.now();
    if (this.onStashRequested) await this.onStashRequested(windowId);
  }

  /**
   * 更新扩展图标 Badge 倒计时文字与醒目背景色
   * @param {number} sec
   */
  updateBadge(sec) {
    try {
      if (chrome.action?.setBadgeText) {
        chrome.action.setBadgeText({ text: `${sec}s` });
        chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
      }
    } catch {}
  }

  /**
   * 向当前窗口所有网页标签广播或动态注入倒计时卡片
   */
  async broadcastBannerToTabs(tabs, payload) {
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      const url = tab.url;

      // 仅针对普通 http/https 页面广播与注入
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        continue;
      }

      const tabId = tab.id;
      try {
        chrome.tabs.sendMessage(
          tabId,
          {
            action: ActionTypes.SHOW_AUTO_STASH_COUNTDOWN,
            payload
          },
          async (res) => {
            if (chrome.runtime.lastError || !res?.success) {
              // 尝试动态注入脚本
              try {
                if (chrome.scripting) {
                  await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ['src/content/content-bundle.js']
                  });
                  setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, {
                      action: ActionTypes.SHOW_AUTO_STASH_COUNTDOWN,
                      payload
                    });
                  }, 120);
                }
              } catch {}
            }
          }
        );
      } catch {}
    }
  }

  /**
   * 清除倒计时状态、徽章与前台卡片
   */
  clearCountdownUI() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    this.remainingSeconds = 0;
    this.deadline = 0;
    try { chrome.alarms?.clear?.(this.alarmName); } catch {}
    this.persistState();

    try {
      if (chrome.action?.setBadgeText) {
        chrome.action.setBadgeText({ text: '' });
      }
    } catch {}

    try {
      if (chrome.notifications) {
        chrome.notifications.clear(this.notificationId);
      }
    } catch {}

    // 广播隐藏所有页面的卡片
    try {
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        if (tabs && tabs.length > 0) {
          for (const tab of tabs) {
            if (tab.id && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
              chrome.tabs.sendMessage(tab.id, { action: ActionTypes.HIDE_AUTO_STASH_COUNTDOWN }).catch(() => {});
            }
          }
        }
      });
    } catch {}
  }

  /**
   * 用户取消自动收纳（清除定时器并进入冷却期）
   */
  handleCancelAutoStash() {
    this.clearCountdownUI();
    this.lastActionTime = Date.now();
    this.persistState();
    return { success: true };
  }

  /**
   * 确认执行自动智能收纳（立即收纳或倒计时结束）
   */
  async handleConfirmAutoStash() {
    this.clearCountdownUI();
    this.lastActionTime = Date.now();
    await this.persistState();
    if (this.onStashRequested) {
      return await this.onStashRequested(this.activeWindowId);
    }
    return { success: false, error: '未注册收纳回调' };
  }

  /**
   * 获取当前倒计时状态
   */
  getCountdownStatus() {
    if (this.deadline > 0) this.remainingSeconds = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
    return {
      isCountingDown: this.remainingSeconds > 0,
      remainingSeconds: this.remainingSeconds,
      totalSeconds: this.totalSeconds
    };
  }

  /**
   * 弹出 Chrome 桌面通知（降级保护）
   * @param {number} count - 当前标签页总数
   * @param {number} threshold - 设定阈值
   * @param {number} [countdownSeconds] - 倒计时秒数
   */
  showThresholdNotification(count, threshold, countdownSeconds = null) {
    if (!chrome.notifications) return;

    const message = countdownSeconds
      ? `当前标签页已达到 ${count} 个（达到或超过阈值 ${threshold} 个），将在 ${countdownSeconds} 秒后自动智能收纳闲置标签。`
      : `当前标签页已达到 ${count} 个（达到或超过阈值 ${threshold} 个），建议进行智能收纳以释放内存。`;

    chrome.notifications.create(
      this.notificationId,
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('src/icons/icon128.png'),
        title: 'BetterBrowse · 标签页收纳提醒',
        message: message,
        buttons: [
          { title: '📦 立即智能收纳' },
          { title: '⚙️ 设置与查看' }
        ],
        requireInteraction: false
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('[ThresholdMonitor] 创建通知失败:', chrome.runtime.lastError);
        }
      }
    );
  }
}

