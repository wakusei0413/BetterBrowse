/**
 * @file search-home.js
 * @description 选项页管理中心主页适配组件（适配共享 src/home 核心视图）
 * @encoding UTF-8
 */

import { HomeView } from '../../home/home-view.js';

export class SearchHomeComponent {
  /**
   * @param {object} [options]
   * @param {HTMLElement} [options.container]
   * @param {() => void} [options.onNavigateToStash]
   */
  constructor(options = {}) {
    this.container = options.container || document.getElementById('tab-search');
    this.onNavigateToStash = options.onNavigateToStash || null;
    this.view = null;
    this.init();
  }

  init() {
    if (!this.container) return;
    this.view = new HomeView({
      container: this.container,
      openTarget: 'new', // 管理中心内在新标签页打开
      isStandalone: false,
      onNavigateToStash: (groupId) => {
        if (typeof this.onNavigateToStash === 'function') {
          this.onNavigateToStash(groupId);
        }
      }
    });
  }

  /**
   * 重新加载偏好配置并刷新主页视图
   */
  async loadConfig() {
    await this.view?.loadConfig?.();
    await this.view?.refreshAll?.();
  }

  /**
   * 激活主页视图（聚焦搜索框、刷新数据）
   */
  activate() {
    this.view?.activate?.();
  }

  /**
   * 离开主页视图（取消定时器、收起下拉框）
   */
  deactivate() {
    this.view?.deactivate?.();
  }

  /**
   * 销毁组件与释放所有监听
   */
  destroy() {
    this.view?.destroy?.();
  }
}
