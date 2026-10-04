/**
 * @file threshold-monitor.js
 * @description 标签页数量阈值监控器（达到阈值时触发全场景 15 秒倒计时弹窗、Badge 动画与智能收纳）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';
import { StorageAdapter } from '../core/storage/storage-adapter.js';
import { StorageKeys } from '../constants/storage-keys.js';
import { MessageBus } from '../core/bus/message-bus.js';
import { filterCountableTabs, isExcludedFromTabCounting, isInjectableWebTab } from '../core/extension-url.js';
import { DeviceEventLog, DeviceEventTypes } from '../core/sync/device-events.js';
import { resolveTabThreshold } from '../constants/config.js';

/** 恢复已过期倒计时的最大宽限期（超过则视为陈旧状态直接丢弃） */
const EXPIRED_DEADLINE_GRACE_MS = 10 * 60 * 1000;
/** Chrome 对一次性闹钟的最短可靠延迟（Chrome 120+ 约为 30 秒） */
const MIN_ALARM_DELAY_MINUTES = 0.5;
/** 视为“已到期”的提前容差，避免闹钟早触发数毫秒就被丢弃 */
const ALARM_DUE_TOLERANCE_MS = 250;
/**
 * 收纳未能任何回收（空操作 / 硬性保护超限）后的重试冷却。
 * 与用户主动确认、取消或成功收纳的完整冷却区分：什么都没收却静默整个冷却期
 * 会让自动收纳在用户看来彻底失效，故只短暂退避后允许再次尝试。
 */
const NOOP_RETRY_COOLDOWN_MS = 60 * 1000;

/**
 * 生成倒计时操作一次性凭证（内容脚本确认/取消必须回传）
 * @returns {string}
 */
function generateActionNonce() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

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
    this.outcomeNotificationId = 'better_browse_stash_outcome_notify';
    this.lastActionTime = 0; // 上次提醒、取消或执行收纳的时间戳（用于冷却防打扰）
    this.noopCooldownUntil = 0; // 收纳空操作后的短暂退避截止时间（随状态持久化）
    this.noopStreak = 0; // 连续空操作次数（退避逐次翻倍，封顶为完整冷却）
    this.remainingSeconds = 0; // 当前剩余秒数
    this.totalSeconds = 15;
    this.activeWindowId = null; // 当前正在倒计时的窗口 ID
    this.deadline = 0;
    this.actionNonce = '';
    this.consumedActionNonce = ''; // 刚被消费的凭证（仅供并入进行中的收口，绝不触发新收纳）
    this.alarmName = 'better-browse-threshold-countdown';
    this.checkDebounceTimer = null;
    this.pendingWindowIds = new Set();
    this.localExpiryTimer = null;
    this.bannerTabIds = new Set(); // 本轮倒计时已投递卡片的标签（供 URL 晚提交时补播且不重复）
    this.bannerContext = null; // 本轮倒计时的计数上下文（供补播卡片显示正确数量）
    this.finalizePromise = null;
    this.stateWriteEpoch = 0; // 状态写纪元：供 restoreState 丢弃读取期间已被覆盖的陈旧快照
    this.persistChain = Promise.resolve();

    this.initListeners();
    // 状态恢复是异步的：alarm 与事件回调必须先等待本 Promise 完成，
    // 否则 SW 冷启动瞬间 deadline/lastActionTime 仍为 0，会导致倒计时丢失或重复触发
    this.readyPromise = this.restoreState();
  }

  /**
   * 仅供浏览器真正启动时调用，不在每次 Service Worker 冷启动时检查。
   */
  async checkOnStartup() {
    await this.readyPromise.catch(() => {});
    await this.checkTabCount();
  }

  initListeners() {
    // 1. 创建、移除与窗口聚焦可能在短时间内成批发生，统一防抖后按涉及窗口检查。
    chrome.tabs.onCreated.addListener((tab) => {
      this.scheduleTabCountCheck(tab?.windowId);
    });
    if (chrome.tabs.onRemoved) {
      chrome.tabs.onRemoved.addListener((_tabId, removeInfo) => {
        this.scheduleTabCountCheck(removeInfo?.windowId);
      });
    }
    if (chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
        const urlReady = Boolean(changeInfo?.url) || changeInfo?.status === 'complete';
        if (!urlReady) return;
        // 新标签创建时 URL 可能尚未提交，最初一次检查会漏计；导航 URL 提交或页面加载完成后
        // 必须重新检查，避免只依赖 onCreated 的 150ms 快照而永久错过阈值触发。
        this.scheduleTabCountCheck(tab?.windowId);
        // 该标签已被计入阈值，但广播时 URL 尚未提交而拿不到卡片：URL 就绪后立即补播，
        // 否则整个倒计时只有系统通知、页面上永远看不到卡片
        this.rebroadcastBannerToTab(tab).catch(() => {});
      });
    }
    if (chrome.windows?.onFocusChanged) {
      chrome.windows.onFocusChanged.addListener((windowId) => {
        if (windowId !== chrome.windows.WINDOW_ID_NONE) {
          this.scheduleTabCountCheck(windowId);
        }
      });
    }

    // 2. 监听通知按钮点击
    if (chrome.notifications && chrome.notifications.onButtonClicked) {
      chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
        if (notifId === this.notificationId) {
          if (btnIdx === 0) {
            // 通知按钮允许在倒计时结束后仍可手动触发收纳（事件回调中的 rejection 必须就地兜底）
            this.handleConfirmAutoStash({ force: true }).catch(() => {});
          } else if (btnIdx === 1 && this.onOpenOptions) {
            Promise.resolve(this.onOpenOptions()).catch(() => {});
          }
          chrome.notifications.clear(this.notificationId);
        } else if (notifId === this.outcomeNotificationId) {
          // 收纳结果提示：按钮 0 直达收纳管理页，供用户手动整理剩余标签
          if (btnIdx === 0 && this.onOpenOptions) {
            Promise.resolve(this.onOpenOptions()).catch(() => {});
          }
          chrome.notifications.clear(this.outcomeNotificationId);
        }
      });
    }
    if (chrome.alarms?.onAlarm) {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm?.name === this.alarmName) this.handleAlarm().catch(() => {});
      });
    }
  }

  /**
   * 合并标签创建、移除与窗口聚焦引发的阈值检查，避免同一批浏览器事件重复全量读取标签。
   * @param {number | undefined} windowId
   */
  scheduleTabCountCheck(windowId) {
    if (typeof windowId === 'number' && windowId > 0) {
      this.pendingWindowIds.add(windowId);
    }
    clearTimeout(this.checkDebounceTimer);
    this.checkDebounceTimer = setTimeout(() => {
      this.checkDebounceTimer = null;
      const windowIds = [...this.pendingWindowIds];
      this.pendingWindowIds.clear();
      const targets = windowIds.length > 0 ? windowIds : [null];
      Promise.allSettled(targets.map((target) => this.checkTabCount(target))).catch(() => {});
    }, 150);
  }

  /**
   * 等待持久化状态恢复完成（SW 冷启动时事件可能早于恢复完成，直接判定会误拒凭证）
   */
  async ensureReady() {
    try {
      await this.readyPromise;
    } catch {}
  }

  async restoreState() {
    const epochBefore = this.stateWriteEpoch;
    let state = null;
    try {
      state = await StorageAdapter.get(StorageKeys.THRESHOLD_STATE, null, 'session');
    } catch {
      return;
    }
    // 恢复读取期间若已有新写入（确认/取消已先行处理），陈旧快照不得回填覆盖内存
    if (this.stateWriteEpoch !== epochBefore) return;
    if (!state) return;
    // 冷却与空操作退避与倒计时无关，必须先恢复：否则用户取消后 SW 一休眠，冷启动检查就会立刻再弹倒计时
    this.lastActionTime = Number(state.lastActionTime) || 0;
    this.noopCooldownUntil = Number(state.noopCooldownUntil) || 0;
    this.noopStreak = Number(state.noopStreak) || 0;
    if (!state.deadline) return;
    // 刚过期不久的倒计时同样恢复：SW 休眠期间 alarm 触发时依赖本状态补发收纳，
    // 只有远超宽限期的陈旧状态才直接丢弃
    if (state.deadline <= Date.now() - EXPIRED_DEADLINE_GRACE_MS) return;
    this.deadline = state.deadline;
    this.activeWindowId = state.activeWindowId ?? null;
    this.totalSeconds = state.totalSeconds || 15;
    this.actionNonce = typeof state.actionNonce === 'string' ? state.actionNonce : '';
    this.remainingSeconds = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    this.updateBadge(this.remainingSeconds);

    if (this.deadline <= Date.now()) {
      // SW 休眠期间已到期：立即补收纳，不再依赖下一次标签事件或已被消费的闹钟。
      // 不 await：避免 readyPromise 与单飞收口互相等待，前台确认可并入同一收口
      this.finalizeCountdown('restored-expired').catch(() => {});
      return;
    }
    // 倒计时未走完：重新挂载进程内定时器与闹钟（同名闹钟覆盖式重建，幂等）
    this.armLocalExpiryTimer();
    this.armCountdownAlarm();
  }

  async persistState() {
    // 同步递增写纪元：供 restoreState 判断读取期间是否已有更新写入
    this.stateWriteEpoch += 1;
    const payload = {
      deadline: this.deadline,
      activeWindowId: this.activeWindowId,
      totalSeconds: this.totalSeconds,
      lastActionTime: this.lastActionTime,
      noopCooldownUntil: this.noopCooldownUntil,
      noopStreak: this.noopStreak,
      actionNonce: this.actionNonce
    };
    // 写入串行化：后一次调用携带的状态一定最后落盘，杜绝旧快照覆盖新状态
    this.persistChain = (this.persistChain || Promise.resolve())
      .then(() => StorageAdapter.set(StorageKeys.THRESHOLD_STATE, payload, 'session'))
      .catch(() => {});
    return await this.persistChain;
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
      // 等待持久化状态恢复完成，避免 SW 冷启动竞态导致冷却/倒计时判定失真
      await this.ensureReady();
      const config = await StorageAdapter.getUserConfig();
      const { windowId, tabs } = await this.getActiveWindowInfo(targetWindowId);
      const countableTabs = filterCountableTabs(tabs);
      const currentCount = countableTabs.length;
      const threshold = resolveTabThreshold(config);
      const now = Date.now();

      // 倒计时归属某个具体窗口：其它窗口的标签增减不得取消它
      const countdownOwnedByOtherWindow = this.deadline > 0
        && this.activeWindowId != null
        && windowId != null
        && windowId !== this.activeWindowId;

      if (countableTabs.length === 0 || currentCount < threshold) {
        if (this.deadline > 0) {
          if (this.deadline <= now) {
            // 倒计时已到期：用户已经等满整个倒计时，无论本窗口是否回落到阈值以下都必须收口。
            // 若此处按"回落即取消"处理，"倒计时中途关掉几个标签"就会把这次收纳彻底丢弃
            await this.finalizeCountdown('expired-check');
          } else if (!countdownOwnedByOtherWindow) {
            // 倒计时仍在进行且属于本窗口，而本窗口已回落到阈值以下 → 正常取消
            this.clearCountdownUI();
          }
          // 仍在进行且属于其它窗口的倒计时：保持不动，交由该窗口自己的到期路径收口
        }
        return;
      }

      const cooldownMinutes = config.thresholdCooldownMinutes || 5;
      const cooldownMs = cooldownMinutes * 60 * 1000;

      // 倒计时已到期但尚未收纳（闹钟被提前消费、SW 休眠等）：立即补执行，避免冷却期把这次收纳永久跳过
      if (this.deadline > 0 && this.deadline <= now) {
        await this.finalizeCountdown('expired-check');
        return;
      }

      // 正在倒计时中、收纳收口进行中或处于冷却期内，不重复打扰
      // （收口期间 deadline 已清零而冷却尚未写入，新开的常驻收纳箱等标签事件会误起第二轮倒计时）
      if (this.deadline > now || this.finalizePromise) {
        return;
      }
      // 空操作（什么都没收）只写入了短暂退避，不应让用户在整个冷却期内再也看不到任何反应
      if (now - this.lastActionTime < cooldownMs || now < this.noopCooldownUntil) {
        return;
      }

      // 1. 若开启了超阈值自动倒计时智能收纳
      if (config.autoStashOnThreshold !== false) {
        await this.startCountdown(windowId, countableTabs, config);
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
  async startCountdown(windowId, tabs, config) {
    // 并发事件（如批量开标签触发多次 onCreated）可能同时进入本方法，倒计时进行中直接忽略
    if (this.deadline > Date.now()) return;

    this.activeWindowId = windowId;
    this.totalSeconds = Math.max(3, config.countdownSeconds || 15);
    this.remainingSeconds = this.totalSeconds;
    this.actionNonce = generateActionNonce();
    this.bannerTabIds.clear();
    this.deadline = Date.now() + this.totalSeconds * 1000;
    const countableTabs = filterCountableTabs(tabs);
    const currentCount = countableTabs.length;
    const threshold = resolveTabThreshold(config);
    this.bannerContext = { currentCount, threshold };

    // 1. 更新 Action 图标 Badge 徽章动画
    this.updateBadge(this.remainingSeconds);

    // 2. 先落盘并挂好到期兜底（进程内定时器 + 闹钟），再向前台广播卡片：
    //    否则前台可能在状态持久化完成前回传确认，读到半初始化状态
    this.armLocalExpiryTimer();
    try {
      await this.persistState();
    } catch {}
    this.armCountdownAlarm();

    // 3. 向当前窗口内所有可用的网页标签广播倒计时卡片
    this.broadcastBannerToTabs(countableTabs, {
      countdownSeconds: this.getRemainingSeconds(),
      currentCount,
      threshold,
      nonce: this.actionNonce
    }).catch(() => {});

    // 4. 弹出系统桌面通知备用
    if (config.autoThresholdNotify) {
      this.showThresholdNotification(currentCount, threshold, this.remainingSeconds);
    }

    // 记录跨设备可见的倒计时事件（仅展示用途，其它设备不执行任何动作）
    DeviceEventLog.append(DeviceEventTypes.COUNTDOWN_START, {
      currentCount,
      threshold,
      countdownSeconds: this.totalSeconds
    }).catch(() => {});
  }

  /**
   * 进程内到期定时器：Service Worker 仍存活时比短时 chrome.alarms 更准时。
   * @param {number} [remainingMs]
   */
  armLocalExpiryTimer(remainingMs = this.deadline - Date.now()) {
    this.clearLocalExpiryTimer();
    const delay = Math.max(0, remainingMs);
    this.localExpiryTimer = setTimeout(() => {
      this.localExpiryTimer = null;
      this.finalizeCountdown('timeout').catch(() => {});
    }, delay);
  }

  clearLocalExpiryTimer() {
    if (this.localExpiryTimer) {
      clearTimeout(this.localExpiryTimer);
      this.localExpiryTimer = null;
    }
  }

  /**
   * 注册一次性到期闹钟。短于 Chrome 最短间隔时仍按目标时刻注册，
   * 若被立即触发则由 handleAlarm 改挂最短可靠备份闹钟。
   */
  armCountdownAlarm() {
    try {
      if (!chrome.alarms?.create || this.deadline <= 0) return;
      chrome.alarms.create(this.alarmName, { when: this.deadline });
    } catch {}
  }

  /**
   * 短时一次性闹钟被 Chrome 提前消费后的兜底：改挂一只**重复**闹钟。
   * 重复闹钟会持续触发，直到收口时被 clearCountdownUI 清除；因此不存在
   * "重挂次数封顶 + SW 休眠带走进程内定时器 = 倒计时永不收口"的漏洞。
   */
  armBackupAlarm() {
    try {
      if (!chrome.alarms?.create || this.deadline <= 0) return;
      chrome.alarms.create(this.alarmName, {
        delayInMinutes: MIN_ALARM_DELAY_MINUTES,
        periodInMinutes: MIN_ALARM_DELAY_MINUTES
      });
    } catch {}
  }

  async handleAlarm() {
    // SW 可能由 alarm 直接唤醒，此时持久化状态尚未恢复：先等待恢复再判定
    await this.ensureReady();
    if (this.finalizePromise) return this.finalizePromise;
    if (this.deadline <= 0 && !this.actionNonce) {
      // 无进行中的倒计时（如会话存储被清空）：清掉残留的重复兜底闹钟，否则它会每 30 秒空唤醒一次 SW
      try { chrome.alarms?.clear?.(this.alarmName); } catch {}
      return;
    }

    const remaining = this.deadline - Date.now();
    // Chrome 不允许短于 30 秒的一次性闹钟按时触发（会提前消费）。只要尚未到期就重新挂好
    // 进程内定时器，并确保始终有一只重复兜底闹钟继续跟进，绝不在此把倒计时丢弃
    if (this.deadline > 0 && remaining > ALARM_DUE_TOLERANCE_MS) {
      this.armLocalExpiryTimer(remaining);
      this.armBackupAlarm();
      return;
    }

    await this.finalizeCountdown('alarm');
  }

  /**
   * 倒计时到期后的唯一收纳入口（闹钟 / 进程内定时器 / 前台归零确认 / 过期检查共用）。
   * 单飞承诺防止多路触发重复收纳。
   * @param {string} [via]
   * @param {{ force?: boolean }} [options]
   */
  async finalizeCountdown(via = 'unknown', { force = false } = {}) {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = this._runFinalize(via, { force });
    try {
      return await this.finalizePromise;
    } finally {
      this.finalizePromise = null;
    }
  }

  /**
   * @param {string} via
   * @param {{ force?: boolean }} options
   */
  async _runFinalize(via, { force = false } = {}) {
    const hadCountdown = this.deadline > 0 || this.remainingSeconds > 0 || Boolean(this.actionNonce);
    if (!force && !hadCountdown) {
      return { success: false, note: '倒计时已结束，已忽略重复的收纳确认请求' };
    }

    const windowId = this.activeWindowId;
    await this.clearCountdownUI();
    DeviceEventLog.append(DeviceEventTypes.COUNTDOWN_CONFIRM, { via }).catch(() => {});
    if (!this.onStashRequested) {
      await this.commitCooldown(true);
      return { success: false, error: '未注册收纳回调' };
    }
    try {
      const res = await this.onStashRequested(windowId);
      DeviceEventLog.append(DeviceEventTypes.STASH_EXECUTED, {
        via,
        success: res?.success !== false
      }).catch(() => {});
      const config = await StorageAdapter.getUserConfig().catch(() => null);
      await this.commitCooldown(via === 'manual' || via === 'manual-force' || Number(res?.stashedCount) > 0, config?.thresholdCooldownMinutes);
      // 只有"未完全达标 / 失败"才弹提示，正常收纳不打扰用户
      this.notifyStashOutcome(res);
      return res;
    } catch (err) {
      await this.commitCooldown(true);
      console.warn('[ThresholdMonitor] 倒计时结束后执行智能收纳失败:', err?.message || err);
      return { success: false, error: err?.message || '智能收纳执行异常' };
    }
  }

  /**
   * 按收纳结果落定冷却策略：
   * - 用户主动确认/取消，或确实收掉了标签 → 完整冷却（防打扰）
   * - 空操作（一个都没收）→ 只写短暂退避，否则用户在整个冷却期内再也看不到任何反应，
   *   自动收纳就会表现为"彻底失效"
   * @param {boolean} fullCooldown
   */
  async commitCooldown(fullCooldown, cooldownMinutes = 5) {
    if (fullCooldown) {
      this.lastActionTime = Date.now();
      this.noopCooldownUntil = 0;
      this.noopStreak = 0;
    } else {
      // 连续空操作逐次翻倍退避（1、2、4… 分钟），封顶为完整冷却：硬性保护超限时
      // 每轮结果都相同，固定 60 秒重试会让倒计时卡片与通知每分钟弹一次
      const capMs = Math.max(1, Number(cooldownMinutes) || 5) * 60 * 1000;
      const backoffMs = Math.min(capMs, NOOP_RETRY_COOLDOWN_MS * 2 ** Math.min(this.noopStreak, 10));
      this.noopStreak += 1;
      this.lastActionTime = 0;
      this.noopCooldownUntil = Date.now() + backoffMs;
    }
    try {
      await this.persistState();
    } catch {}
  }

  /**
   * 收纳结果可见提示：收纳未能完全达标或直接失败时，把原因与下一步动作告知用户，
   * 而不是只留在控制台日志里
   * @param {any} res - onStashRequested 的返回值
   */
  notifyStashOutcome(res) {
    if (!chrome.notifications?.create) return;
    const failed = res?.success === false;
    const notReached = res?.reachedTarget === false;
    if (!failed && !notReached) return;

    const stashedCount = Number(res?.stashedCount) || 0;
    const keptCount = Number(res?.keptCount);
    const remaining = Number(res?.remainingOverThreshold);
    let message;
    if (failed) {
      message = res?.error || res?.note || '本次自动收纳未能执行，请手动整理标签页。';
    } else if (stashedCount > 0) {
      message = `已收纳 ${stashedCount} 个闲置标签，但仍有 `
        + (Number.isFinite(remaining) ? `${remaining} 个受保护标签` : '部分受保护标签')
        + '超出目标数量'
        + (Number.isFinite(keptCount) ? `（保留 ${keptCount} 个）` : '')
        + '，建议手动整理。';
    } else {
      message = res?.note || '本次没有可安全收纳的标签页，受保护的标签页已全部保留。';
    }

    try {
      chrome.notifications.create(
        this.outcomeNotificationId,
        {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('src/icons/icon128.png'),
          title: 'BetterBrowse · 自动收纳结果',
          message,
          buttons: [{ title: '⚙️ 打开收纳管理' }],
          requireInteraction: false
        },
        () => {
          if (chrome.runtime.lastError) {
            console.warn('[ThresholdMonitor] 创建收纳结果通知失败:', chrome.runtime.lastError?.message || '未知错误');
          }
        }
      );
    } catch {}
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
   * 当前倒计时剩余秒数（下限 3 秒，与内容脚本卡片保持一致）
   * @returns {number}
   */
  getRemainingSeconds() {
    if (this.deadline <= 0) return Math.max(3, this.totalSeconds);
    return Math.max(3, Math.ceil((this.deadline - Date.now()) / 1000));
  }

  /**
   * 取卡片文案所需的计数上下文。正常情况下沿用倒计时启动时算好的值；
   * SW 中途休眠重启后内存上下文已丢失，则按当前窗口重新推导，避免补播卡片显示 0。
   * @returns {Promise<{ currentCount: number, threshold: number }|null>}
   */
  async getBannerContext() {
    if (this.bannerContext) return this.bannerContext;
    try {
      const config = await StorageAdapter.getUserConfig();
      const { tabs } = await this.getActiveWindowInfo(this.activeWindowId);
      this.bannerContext = {
        currentCount: filterCountableTabs(tabs).length,
        threshold: resolveTabThreshold(config)
      };
      return this.bannerContext;
    } catch {
      return null;
    }
  }

  /**
   * 向当前窗口所有网页标签广播或动态注入倒计时卡片
   * 走 MessageBus.sendToFrame：统一吞掉 MV3 sendMessage 在 callback 模式下仍会拒绝的 Promise
   * @param {Array<chrome.tabs.Tab>} tabs
   * @param {{ countdownSeconds: number, nonce: string }} payload
   */
  async broadcastBannerToTabs(tabs, payload) {
    for (const tab of tabs) {
      await this.sendBannerToTab(tab, payload);
    }
  }

  /**
   * 向单个标签投递倒计时卡片。同一轮倒计时内每个标签只投递一次，
   * 否则补播会把页面上已经开始走的倒计时重置回整轮秒数。
   * @param {chrome.tabs.Tab} tab
   * @param {{ countdownSeconds: number, nonce: string }} payload
   * @returns {Promise<boolean>} 是否成功投递
   */
  async sendBannerToTab(tab, payload) {
    if (!tab?.id) return false;
    // URL 口径必须与阈值计数一致（允许 pendingUrl）：否则未提交导航的标签算得进阈值，
    // 却因为 tab.url 为空被跳过，页面上永远看不到卡片
    if (!isInjectableWebTab(tab)) return false;
    if (this.bannerTabIds.has(tab.id)) return false;
    this.bannerTabIds.add(tab.id);

    const tabId = tab.id;
    const delivered = await this._deliverBanner(tabId, payload);
    // 投递失败必须撤销标记：URL 晚提交的标签此刻无法注入，onUpdated 补播时还要再试
    if (!delivered) this.bannerTabIds.delete(tabId);
    return delivered;
  }

  /**
   * @param {number} tabId
   * @param {object} payload
   * @returns {Promise<boolean>}
   */
  async _deliverBanner(tabId, payload) {
    try {
      const res = await MessageBus.sendToFrame(tabId, 0, ActionTypes.SHOW_AUTO_STASH_COUNTDOWN, payload, 800);
      if (res?.success) return true;

      // 内容脚本尚未注入（刚打开的页面 / 被 CSP 阻断后动态注入）
      if (!chrome.scripting) return false;
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/content/content-bundle.js']
        });
      } catch {
        return false;
      }
      const retried = await MessageBus.sendToFrame(tabId, 0, ActionTypes.SHOW_AUTO_STASH_COUNTDOWN, payload, 800);
      return Boolean(retried?.success);
    } catch {
      // 标签页在探测/注入期间被关闭属正常竞态
      return false;
    }
  }

  /**
   * 倒计时进行中，为 URL 刚刚提交的标签补投卡片。
   * 这类标签在广播时 tab.url 尚为空而被跳过，不补投则整个倒计时页面上都看不到卡片。
   * @param {chrome.tabs.Tab} tab
   */
  async rebroadcastBannerToTab(tab) {
    if (!tab?.id || this.deadline <= Date.now() || !this.actionNonce) return;
    if (this.bannerTabIds.has(tab.id)) return;
    // 只补播倒计时所属窗口：其它窗口的卡片一旦被确认，会收纳错误的窗口
    if (this.activeWindowId != null && tab.windowId !== this.activeWindowId) return;
    if (isExcludedFromTabCounting(tab)) return;
    const context = await this.getBannerContext();
    if (!context) return;
    await this.sendBannerToTab(tab, {
      countdownSeconds: this.getRemainingSeconds(),
      currentCount: context.currentCount,
      threshold: context.threshold,
      nonce: this.actionNonce
    });
  }

  /**
   * 清除倒计时状态、徽章与前台卡片
   */
  async clearCountdownUI() {
    this.clearLocalExpiryTimer();
    this.remainingSeconds = 0;
    this.deadline = 0;
    this.bannerTabIds.clear();
    this.bannerContext = null;
    // 记住刚消费的凭证：后台补执行与前台确认并发时，前台确认可并入同一收口而不被误拒
    if (this.actionNonce) {
      this.consumedActionNonce = this.actionNonce;
    }
    this.actionNonce = '';
    try { chrome.alarms?.clear?.(this.alarmName); } catch {}
    this.persistState().catch(() => {});

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

    // 广播隐藏所有页面的卡片（遍历全部窗口，避免其他窗口的卡片残留）
    try {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError || !tabs || tabs.length === 0) return;
        for (const tab of tabs) {
          if (tab.id && isInjectableWebTab(tab)) {
            MessageBus.sendToFrame(tab.id, 0, ActionTypes.HIDE_AUTO_STASH_COUNTDOWN, null, 400).catch(() => {});
          }
        }
      });
    } catch {}
  }

  /**
   * 校验内容脚本回传的倒计时一次性凭证
   * @param {unknown} nonce
   * @returns {boolean}
   */
  matchesActionNonce(nonce) {
    return typeof this.actionNonce === 'string'
      && this.actionNonce.length >= 16
      && nonce === this.actionNonce;
  }

  /**
   * 判断凭证是否为刚被消费掉的那一个（仅允许并入进行中的收口或返回去重结果，绝不触发新收纳）
   * @param {unknown} nonce
   * @returns {boolean}
   */
  matchesConsumedNonce(nonce) {
    return typeof this.consumedActionNonce === 'string'
      && this.consumedActionNonce.length >= 16
      && nonce === this.consumedActionNonce;
  }

  /**
   * 用户取消自动收纳（清除定时器并进入冷却期）
   * @param {{ nonce?: string, requireNonce?: boolean }} [options]
   */
  async handleCancelAutoStash(options = {}) {
    await this.ensureReady();
    if (options.requireNonce && !this.matchesActionNonce(options.nonce)) {
      return { success: false, error: '倒计时操作凭证无效' };
    }
    await this.clearCountdownUI();
    // 用户主动取消：完整冷却，并清掉可能残留的空操作退避
    await this.commitCooldown(true);
    DeviceEventLog.append(DeviceEventTypes.COUNTDOWN_CANCEL, {}).catch(() => {});
    return { success: true };
  }

  /**
   * 确认执行自动智能收纳（立即收纳或倒计时结束）
   * @param {{ force?: boolean, nonce?: string, requireNonce?: boolean }} [options] - force=true 时无视"倒计时已结束"守卫（如通知按钮路径）
   * @returns {Promise<any>}
   */
  async handleConfirmAutoStash(options = {}) {
    await this.ensureReady();
    if (options.requireNonce && !this.matchesActionNonce(options.nonce)) {
      // 凭证已被同源倒计时消费（闹钟/恢复补执行刚触发）：并入进行中的收口或返回去重结果，
      // 只有真正陌生的凭证才判无效，避免随机误报"凭证无效"让用户无法确认
      if (this.matchesConsumedNonce(options.nonce)) {
        if (this.finalizePromise) return await this.finalizePromise;
        if (this.deadline <= 0) return await this.finalizeCountdown('manual', { force: false });
      }
      return { success: false, error: '倒计时操作凭证无效' };
    }
    // 过期但尚未收纳的倒计时仍允许确认（deadline 仍 > 0）；已 clear 后的残留按钮由 finalize 去重。
    // 通知按钮等可信入口通过 force 在倒计时已清除后仍可手动补收纳。
    return await this.finalizeCountdown(options.force ? 'manual-force' : 'manual', {
      force: Boolean(options.force)
    });
  }

  /**
   * 获取当前倒计时状态
   * @returns {Promise<{ isCountingDown: boolean, remainingSeconds: number, totalSeconds: number }>}
   */
  async getCountdownStatus() {
    await this.ensureReady();
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
          console.warn('[ThresholdMonitor] 创建通知失败:', chrome.runtime.lastError?.message || '未知错误');
        }
      }
    );
  }
}

