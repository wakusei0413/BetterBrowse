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
   */
  static show({ countdownSeconds = 15, currentCount = 15, threshold = 15 } = {}) {
    // 若已有实例在展示，先平滑销毁
    if (this.currentInstance) {
      this.currentInstance.destroy();
    }

    const banner = new CountdownBanner({
      countdownSeconds,
      currentCount,
      threshold
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

  constructor({ countdownSeconds, currentCount, threshold }) {
    this.totalSeconds = Math.max(3, countdownSeconds || 15);
    this.remainingSeconds = this.totalSeconds;
    this.currentCount = currentCount;
    this.threshold = threshold;
    this.timer = null;
    this.hostElement = null;
    this.shadowRoot = null;
    this.isProcessing = false;
  }

  /**
   * 渲染 Shadow DOM
   */
  render() {
    // 1. 创建容器 Host
    this.hostElement = document.createElement('better-browse-countdown-root');
    this.hostElement.style.all = 'initial';
    this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });

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
          width: 330px;
          background: rgba(255, 255, 255, 0.96);
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
          font-size: 16px;
          line-height: 1;
        }

        .card-title {
          font-size: 13px;
          font-weight: 600;
          color: #111827;
        }

        .threshold-tag {
          font-size: 11px;
          font-weight: 500;
          color: #d97706;
          background: #fef3c7;
          padding: 2px 6px;
          border-radius: 6px;
        }

        .btn-close {
          background: transparent;
          border: none;
          color: #9ca3af;
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
          padding: 4px;
          border-radius: 4px;
          transition: all 0.15s ease;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .btn-close:hover {
          color: #4b5563;
          background: rgba(0, 0, 0, 0.05);
        }

        /* 主体说明与倒计时数字 */
        .card-body {
          margin-bottom: 12px;
          color: #4b5563;
        }

        .highlight-text {
          font-weight: 600;
          color: #111827;
        }

        .countdown-indicator {
          display: inline-flex;
          align-items: center;
          font-weight: 700;
          color: #2563eb;
          background: #eff6ff;
          padding: 1px 6px;
          border-radius: 4px;
          margin: 0 2px;
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
          padding: 6px 12px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          border: 1px solid transparent;
          transition: all 0.15s ease;
          line-height: 1.2;
          user-select: none;
        }

        .btn-secondary {
          background: #f3f4f6;
          color: #4b5563;
          border-color: #e5e7eb;
        }

        .btn-secondary:hover {
          background: #e5e7eb;
          color: #1f2937;
        }

        .btn-primary {
          background: #2563eb;
          color: #ffffff;
        }

        .btn-primary:hover {
          background: #1d4ed8;
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        /* 深色模式自适应 */
        @media (prefers-color-scheme: dark) {
          .banner-card {
            background: rgba(30, 41, 59, 0.94);
            border-color: rgba(255, 255, 255, 0.1);
            color: #e2e8f0;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
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
          .threshold-tag {
            background: rgba(217, 119, 6, 0.2);
            color: #fbbf24;
          }
          .btn-close {
            color: #94a3b8;
          }
          .btn-close:hover {
            color: #f1f5f9;
            background: rgba(255, 255, 255, 0.08);
          }
          .countdown-indicator {
            background: rgba(37, 99, 235, 0.25);
            color: #93c5fd;
          }
          .progress-track {
            background: #334155;
          }
          .btn-secondary {
            background: #334155;
            color: #e2e8f0;
            border-color: #475569;
          }
          .btn-secondary:hover {
            background: #475569;
            color: #ffffff;
          }
        }
      </style>

      <div class="banner-card" id="bannerCard">
        <div class="card-header">
          <div class="header-title-wrap">
            <span class="card-icon">📦</span>
            <span class="card-title">BetterBrowse</span>
            <span class="threshold-tag">标签已满 ${this.currentCount}</span>
          </div>
          <button class="btn-close" id="btnClose" title="关闭并取消本次收纳" aria-label="关闭">✕</button>
        </div>

        <div class="card-body" id="cardBody">
          当前标签数已达 <span class="highlight-text">${this.currentCount}</span> 个（阈值 ${this.threshold}），将在 <span class="countdown-indicator" id="countdownNum">${this.remainingSeconds}s</span> 后自动智能收纳闲置标签...
        </div>

        <div class="progress-track">
          <div class="progress-bar" id="progressBar" style="width: 100%;"></div>
        </div>

        <div class="card-actions" id="cardActions">
          <button class="btn btn-secondary" id="btnCancel">取消收纳</button>
          <button class="btn btn-primary" id="btnStashNow">立即收纳</button>
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
        countdownNum.textContent = `${this.remainingSeconds}s`;
      }

      if (progressBar) {
        const percent = Math.max(0, (this.remainingSeconds / this.totalSeconds) * 100);
        progressBar.style.width = `${percent}%`;
      }

      // 倒计时结束，触发自动智能收纳
      if (this.remainingSeconds <= 0) {
        clearInterval(this.timer);
        this.timer = null;
        this.confirmAutoStash();
      }
    }, 1000);
  }

  /**
   * 取消自动收纳（通知后台并进入冷却）
   */
  cancelAutoStash() {
    this.stopTimer();
    try {
      chrome.runtime.sendMessage({ action: ActionTypes.CANCEL_AUTO_STASH });
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
      cardBody.innerHTML = '⏳ 正在评估规则并智能收纳闲置标签...';
    }
    if (cardActions) {
      cardActions.style.display = 'none';
    }
    if (progressBar) {
      progressBar.style.width = '100%';
    }

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: ActionTypes.CONFIRM_AUTO_STASH }, (res) => {
          resolve(res);
        });
      });

      if (response && response.success && response.data) {
        const { stashedCount, keptCount } = response.data;
        if (cardBody) {
          if (stashedCount > 0) {
            cardBody.innerHTML = `✅ 已智能收纳 <strong>${stashedCount}</strong> 个闲置标签（保留 <strong>${keptCount || 0}</strong> 个活跃标签）`;
          } else {
            cardBody.innerHTML = 'ℹ️ 当前所有标签均处于活跃/保护状态，未收纳标签';
          }
        }
      } else {
        if (cardBody) {
          cardBody.innerHTML = '收纳已触发完成';
        }
      }
    } catch (err) {
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
