/**
 * @file about.js
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
import { Toast } from './toast.js';




export class AboutComponent {
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
