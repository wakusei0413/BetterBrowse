/**
 * @file countdown-banner.js
 * @description 网页端超阈值智能收纳倒计时悬浮卡片（采用 Shadow DOM 彻底隔离宿主样式）
 * @encoding UTF-8
 */

import { ActionTypes } from '../constants/action-types.js';

export class CountdownBanner {
  static currentInstance = null;

  /**
   * 在当前页面展示倒计时卡片
   * @param {Object} options
   * @param {number} [options.countdownSeconds=15] - 倒计时秒数
   * @param {number} [options.currentCount=15] - 当前标签页总数
   * @param {number} [options.threshold=15] - 设定的阈值
   * @param {string} [options.nonce=''] - 后台签发的一次性操作凭证
   */
  static show({ countdownSeconds = 15, currentCount = 15, threshold = 15, nonce = '' } = {}) {
    // 若已有实例在展示，先平滑销毁
    if (this.currentInstance) {
      this.currentInstance.destroy();
    }

    const banner = new CountdownBanner({
      countdownSeconds,
      currentCount,
      threshold,
      nonce
    });
    banner.render();
    this.currentInstance = banner;
    return banner;
  }

  /**
   * 销毁并隐藏倒计时卡片
   */
  static hide() {
    if (this.currentInstance) {
      this.currentInstance.fadeOutAndRemove();
    }
  }

  constructor({ countdownSeconds, currentCount, threshold, nonce }) {
    this.totalSeconds = Math.max(3, countdownSeconds || 15);
    this.remainingSeconds = this.totalSeconds;
    this.currentCount = currentCount;
    this.threshold = threshold;
    this.nonce = typeof nonce === 'string' ? nonce : '';
    this.timer = null;
    this.hostElement = null;
    this.shadowRoot = null;
    this.isProcessing = false;
  }

  /**
   * 渲染 Shadow DOM
   */
  render() {
    // 1. 创建容器 Host：普通 div + closed Shadow，避免网页通过自定义标签名拿到内部按钮
    this.hostElement = document.createElement('div');
    this.shadowRoot = this.hostElement.attachShadow({ mode: 'closed' });

    // 2. 注入独立样式与 HTML
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
          display: block !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          position: fixed !important;
          top: 24px !important;
          right: 24px !important;
          z-index: 2147483647 !important;
          pointer-events: auto !important;
        }

        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        .banner-card {
          width: 340px;
          background: rgba(255, 255, 255, 0.98);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(0, 0, 0, 0.08);
          border-radius: 14px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12), 0 1px 4px rgba(0, 0, 0, 0.06);
          padding: 16px;
          color: #1f2937;
          font-size: 13px;
          line-height: 1.5;
          animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          transition: opacity 0.25s ease, transform 0.25s ease;
          overflow: hidden;
        }

        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(-16px) scale(0.96);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .banner-card.fade-out {
          opacity: 0;
          transform: translateY(-12px) scale(0.96);
        }

        /* 头部信息 */
        .card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 10px;
        }

        .header-title-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .card-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #2563eb;
          line-height: 1;
        }

        .card-icon-svg {
          width: 16px;
          height: 16px;
        }

        .card-title {
          font-size: 13px;
          font-weight: 600;
          color: #111827;
        }

        .threshold-tag {
          font-size: 11px;
          font-weight: 500;
          color: #b45309;
          background: #fef3c7;
          border: 1px solid #fde68a;
          padding: 1px 6px;
          border-radius: 6px;
        }

        .btn-close {
          background: transparent;
          border: none;
          color: #6b7280;
          cursor: pointer;
          width: 32px;
          height: 32px;
          min-width: 32px;
          min-height: 32px;
          border-radius: 6px;
          transition: color 0.15s ease, background 0.15s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
        }

        .btn-close:hover {
          color: #111827;
          background: rgba(0, 0, 0, 0.06);
        }

        .btn-close:focus-visible {
          outline: 2px solid #2563eb;
          outline-offset: 1px;
        }

        /* 主体说明与倒计时数字 */
        .card-body {
          margin-bottom: 10px;
          color: #374151;
          font-size: 13px;
          line-height: 1.5;
        }

        .highlight-text {
          font-weight: 600;
          color: #111827;
        }

        .countdown-indicator {
          display: inline-flex;
          align-items: center;
          font-weight: 700;
          color: #1d4ed8;
          background: #eff6ff;
          border: 1px solid #dbeafe;
          padding: 1px 6px;
          border-radius: 4px;
          margin: 0 2px;
        }

        .card-retention-note {
          margin-top: 6px;
          font-size: 11px;
          line-height: 1.4;
          color: #6b7280;
        }

        /* 进度条 */
        .progress-track {
          width: 100%;
          height: 3px;
          background: #e5e7eb;
          border-radius: 2px;
          overflow: hidden;
          margin-bottom: 14px;
        }

        .progress-bar {
          height: 100%;
          width: 100%;
          background: linear-gradient(90deg, #3b82f6, #6366f1);
          border-radius: 2px;
          transition: width 1s linear;
        }

        /* 按钮操作组 */
        .card-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 32px;
          padding: 0 12px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          border: 1px solid transparent;
          transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
          line-height: 1.2;
          user-select: none;
          text-decoration: none;
        }

        .btn-secondary {
          background: #f3f4f6;
          color: #374151;
          border-color: #e5e7eb;
        }

        .btn-secondary:hover {
          background: #e5e7eb;
          color: #111827;
          border-color: #d1d5db;
        }

        .btn-primary {
          background: #2563eb;
          color: #ffffff;
          border-color: #2563eb;
        }

        .btn-primary:hover {
          background: #1d4ed8;
          border-color: #1d4ed8;
        }

        .btn:focus-visible {
          outline: 2px solid #2563eb;
          outline-offset: 1px;
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        /* 减弱动画模式适配 */
        @media (prefers-reduced-motion: reduce) {
          .banner-card {
            animation: none !important;
            transition: none !important;
            transform: none !important;
            opacity: 1 !important;
          }
          .banner-card.fade-out {
            animation: none !important;
            transition: none !important;
            opacity: 0 !important;
          }
          .progress-bar {
            transition: none !important;
          }
          .btn,
          .btn-close {
            transition: none !important;
          }
        }

        /* 深色模式自适应与高对比度补全 */
        @media (prefers-color-scheme: dark) {
          .banner-card {
            background: rgba(30, 41, 59, 0.96);
            border-color: rgba(255, 255, 255, 0.12);
            color: #e2e8f0;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
          }
          .card-icon {
            color: #60a5fa;
          }
          .card-title {
            color: #f8fafc;
          }
          .card-body {
            color: #cbd5e1;
          }
          .highlight-text {
            color: #ffffff;
          }
          .card-retention-note {
            color: #94a3b8;
          }
          .threshold-tag {
            background: rgba(217, 119, 6, 0.2);
            color: #fbbf24;
            border-color: rgba(245, 158, 11, 0.35);
          }
          .btn-close {
            color: #94a3b8;
          }
          .btn-close:hover {
            color: #f8fafc;
            background: rgba(255, 255, 255, 0.1);
          }
          .countdown-indicator {
            background: rgba(37, 99, 235, 0.25);
            color: #93c5fd;
            border-color: rgba(96, 165, 250, 0.3);
          }
          .progress-track {
            background: #334155;
          }
          .progress-bar {
            background: linear-gradient(90deg, #60a5fa, #818cf8);
          }
          .btn-secondary {
            background: #334155;
            color: #f1f5f9;
            border-color: #475569;
          }
          .btn-secondary:hover {
            background: #475569;
            color: #ffffff;
            border-color: #64748b;
          }
          .btn-primary {
            background: #3b82f6;
            color: #ffffff;
            border-color: #3b82f6;
          }
          .btn-primary:hover {
            background: #2563eb;
            border-color: #2563eb;
          }
        }
      </style>

      <div class="banner-card" id="bannerCard" role="dialog" aria-modal="false" aria-labelledby="bannerTitle" aria-describedby="cardBody" aria-live="polite">
        <div class="card-header">
          <div class="header-title-wrap">
            <span class="card-icon" aria-hidden="true">
              <svg class="card-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect width="20" height="5" x="2" y="3" rx="1"/>
                <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>
                <path d="M10 12h4"/>
              </svg>
            </span>
            <span class="card-title" id="bannerTitle">BetterBrowse</span>
            <span class="threshold-tag">标签已达 ${this.currentCount}</span>
          </div>
          <button class="btn-close" id="btnClose" type="button" title="取消本次收纳" aria-label="取消本次收纳">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 6 6 18"/>
              <path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>

        <div class="card-body" id="cardBody">
          <div>当前有 <span class="highlight-text">${this.currentCount}</span> 个标签（上限 ${this.threshold}），将在 <span class="countdown-indicator" id="countdownNum">${this.remainingSeconds} 秒</span> 后收走闲置标签。</div>
          <div class="card-retention-note">正在播放、正在输入、固定及当前标签页将自动保留。</div>
        </div>

        <div class="progress-track" aria-hidden="true">
          <div class="progress-bar" id="progressBar"></div>
        </div>

        <div class="card-actions" id="cardActions">
          <button class="btn btn-secondary" id="btnCancel" type="button">先别收</button>
          <button class="btn btn-primary" id="btnStashNow" type="button">现在收闲置标签</button>
        </div>
      </div>
    `;

    // 确保 Host 节点内联样式最高优先级
    this.hostElement.style.cssText = 'all: initial !important; display: block !important; position: fixed !important; top: 24px !important; right: 24px !important; z-index: 2147483647 !important; pointer-events: auto !important;';

    const targetContainer = document.body || document.documentElement;
    if (targetContainer) {
      targetContainer.appendChild(this.hostElement);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        (document.body || document.documentElement)?.appendChild(this.hostElement);
      });
    }

    // 3. 绑定交互事件
    this.bindEvents();

    // 4. 启动 1 秒心跳定时器
    this.startCountdown();
  }

  bindEvents() {
    const btnClose = this.shadowRoot.getElementById('btnClose');
    const btnCancel = this.shadowRoot.getElementById('btnCancel');
    const btnStashNow = this.shadowRoot.getElementById('btnStashNow');

    const handleCancel = () => {
      if (this.isProcessing) return;
      this.cancelAutoStash();
    };

    btnClose.addEventListener('click', handleCancel);
    btnCancel.addEventListener('click', handleCancel);

    btnStashNow.addEventListener('click', () => {
      if (this.isProcessing) return;
      this.confirmAutoStash();
    });
  }

  /**
   * 启动每秒递减定时器
   */
  startCountdown() {
    const countdownNum = this.shadowRoot.getElementById('countdownNum');
    const progressBar = this.shadowRoot.getElementById('progressBar');

    this.timer = setInterval(() => {
      this.remainingSeconds -= 1;

      if (countdownNum) {
        countdownNum.textContent = `${this.remainingSeconds} 秒`;
      }

      if (progressBar) {
        const percent = Math.max(0, (this.remainingSeconds / this.totalSeconds) * 100);
        progressBar.style.width = `${percent}%`;
      }

      // 倒计时仅负责展示，自动收纳由后台唯一计时器触发，避免重复执行
      if (this.remainingSeconds <= 0) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 1000);
  }

  /**
   * 取消自动收纳（通知后台并进入冷却）
   */
  cancelAutoStash() {
    this.stopTimer();
    try {
      const chromeResult = chrome.runtime.sendMessage({
        action: ActionTypes.CANCEL_AUTO_STASH,
        payload: { nonce: this.nonce }
      }, () => {
        // 显式消费 lastError，避免扩展重载后产生未处理的错误噪音
        void chrome.runtime.lastError;
      });
      if (chromeResult != null && typeof chromeResult.then === 'function') {
        chromeResult.then(() => {}, () => {});
      }
    } catch {
      // 忽略通信断开
    }
    this.fadeOutAndRemove();
  }

  /**
   * 确认执行自动智能收纳
   */
  async confirmAutoStash() {
    this.stopTimer();
    this.isProcessing = true;

    const cardBody = this.shadowRoot.getElementById('cardBody');
    const cardActions = this.shadowRoot.getElementById('cardActions');
    const progressBar = this.shadowRoot.getElementById('progressBar');

    if (cardBody) {
      cardBody.innerHTML = '正在按规则收纳闲置标签…';
    }
    if (cardActions) {
      cardActions.style.display = 'none';
    }
    if (progressBar) {
      progressBar.style.width = '100%';
    }

    try {
      const response = await new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          // 后台无响应（扩展重载/SW 休眠）时的超时兜底，避免卡片永久停留在"正在评估"
          resolve(null);
        }, 10000);
        try {
          const chromeResult = chrome.runtime.sendMessage({
            action: ActionTypes.CONFIRM_AUTO_STASH,
            payload: { nonce: this.nonce }
          }, (res) => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(res);
          });
          if (chromeResult != null && typeof chromeResult.then === 'function') {
            chromeResult.then(() => {}, () => {});
          }
        } catch {
          clearTimeout(timeoutId);
          resolve(null);
        }
      });

      if (response && response.success && response.data) {
        const { stashedCount, keptCount } = response.data;
        if (cardBody) {
          if (stashedCount > 0) {
            cardBody.innerHTML = `已按规则收纳 <strong>${stashedCount}</strong> 个闲置标签（已保留 <strong>${keptCount || 0}</strong> 个活跃或保护标签）`;
          } else {
            cardBody.innerHTML = '当前所有标签均处于活跃或保护状态，未收纳标签';
          }
        }
      } else if (response && !response.success) {
        if (cardBody) {
          cardBody.innerHTML = '当前无可收纳的闲置标签页';
        }
      } else {
        if (cardBody) {
          cardBody.innerHTML = '收纳指令已发送';
        }
      }
    } catch {
      if (cardBody) {
        cardBody.innerHTML = '收纳指令已发送';
      }
    }

    // 展示结果 1.5 秒后平滑淡出
    setTimeout(() => {
      this.fadeOutAndRemove();
    }, 1500);
  }

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 平滑淡出并移除 DOM
   */
  fadeOutAndRemove() {
    const card = this.shadowRoot?.getElementById('bannerCard');
    if (card) {
      card.classList.add('fade-out');
      setTimeout(() => {
        this.destroy();
      }, 250);
    } else {
      this.destroy();
    }
  }

  destroy() {
    this.stopTimer();
    if (this.hostElement && this.hostElement.parentNode) {
      this.hostElement.parentNode.removeChild(this.hostElement);
    }
    this.hostElement = null;
    this.shadowRoot = null;
    if (CountdownBanner.currentInstance === this) {
      CountdownBanner.currentInstance = null;
    }
  }
}

