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
    /** 宿主当前是否要求主页处于激活态（视图异步就绪前的激活/停用请求以此为准） */
    this.wantActive = false;
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
    // 共享视图在管理中心中默认挂载但不激活：只有路由真正进入主页时才绑定全局快捷键、启动时钟与拉取数据
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
    this.wantActive = true;
    const run = () => {
      if (this.wantActive) this.view?.activate?.();
    };
    if (this.view?.ready) this.view.ready.then(run).catch(() => {});
    else run();
  }

  /**
   * 聚焦主页搜索框并按范围检索（时间线等入口的统一跳转目标）
   * @param {string} [scope='all']
   */
  focusSearch(scope = 'all') {
    this.view?.focusSearch?.(scope);
  }

  /**
   * 离开主页视图（取消定时器、收起下拉框）
   */
  deactivate() {
    this.wantActive = false;
    this.view?.deactivate?.();
  }

  /**
   * 销毁组件与释放所有监听
   */
  destroy() {
    this.view?.destroy?.();
  }
}
