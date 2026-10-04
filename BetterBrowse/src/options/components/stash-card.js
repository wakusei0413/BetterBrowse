/**
 * @file stash-card.js
 * @description 时间线收纳组卡片与条目行的纯渲染函数（无状态，便于复用与测试）
 * @encoding UTF-8
 */

import { TABS_INITIAL_LIMIT } from '../list-window.js';
import { TimeTreeBuilder } from '../ui/time-tree.js';
import { formatStashTime } from '../../core/stash/group-title.js';

/**
 * 转义 HTML（含单引号，防止单引号属性场景下的注入）
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 相对时间文案（刚刚 / N 分钟前 / … / N 年前）
 * @param {number} timestamp
 * @returns {string}
 */
export function formatTimeAgo(timestamp) {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)} 天前`;
  if (diffSec < 31536000) return `${Math.max(1, Math.floor(diffSec / 2592000))} 个月前`;
  return `${Math.floor(diffSec / 31536000)} 年前`;
}

/**
 * 组卡片头部的渲染签名：任一字段变化都意味着复用的卡片头部已过期
 * @param {{ title?: string, starred?: boolean, locked?: boolean, color?: string, itemCount?: number, createdAt?: number }} group
 * @returns {string}
 */
export function headerSignature(group) {
  return JSON.stringify([group.title || '', Boolean(group.starred), Boolean(group.locked), group.color || '', Number(group.itemCount) || 0, group.createdAt || 0]);
}

/**
 * 组内单条网页行
 * @param {string} groupId
 * @param {{ id: string, url?: string, title?: string, favIconUrl?: string }} tab
 * @returns {string}
 */
export function renderItemRowHtml(groupId, tab) {
  const safeGroupId = escapeHTML(groupId);
  const safeTabId = escapeHTML(tab.id);
  // 同时带上真实 favIconUrl 与页面 URL：后台优先抓取 Chrome 记录的图标资源，
  // 缺失时（OneTab 导入、剔除图标的备份快照）再按页面域名回退 /favicon.ico。
  const faviconSrc = tab.favIconUrl || tab.url || '';
  const pageUrl = tab.url || '';
  const faviconAttr = faviconSrc ? ` data-favicon-url="${escapeHTML(faviconSrc)}"` : '';
  const pageUrlAttr = pageUrl ? ` data-page-url="${escapeHTML(pageUrl)}"` : '';
  return `
      <li class="stash-item-row" data-group-id="${safeGroupId}" data-item-id="${safeTabId}">
        <div class="stash-item-main">
          <svg class="tab-favicon tab-favicon-fallback"${faviconAttr}${pageUrlAttr} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
          <a href="${escapeHTML(tab.url || '')}" class="tab-link btn-restore-item-link" data-group-id="${safeGroupId}" data-item-id="${safeTabId}" title="${escapeHTML(tab.title || tab.url || '')}&#10;${escapeHTML(tab.url || '')}">
            <span class="tab-title">${escapeHTML(tab.title || tab.url || '')}</span>
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

/**
 * 组卡片内部 HTML（头部、条目列表与"展开其余"按钮）
 * @param {any} group - 组摘要
 * @param {{ expanded: boolean, itemWindow: { padTop: number, padBottom: number }, itemsHtml: string }} options
 * @returns {string}
 */
export function renderGroupCardHtml(group, { expanded, itemWindow, itemsHtml }) {
  const createdAt = TimeTreeBuilder.getGroupTimestamp(group);
  const dateObj = new Date(createdAt);
  const dateStr = formatStashTime(dateObj);

  const timeAgo = formatTimeAgo(createdAt);
  const tabCount = Number(group.itemCount) || 0;
  const displayGroupName = group.title || `${tabCount} 个标签页`;
  const safeGroupId = escapeHTML(group.id);
  const hasMoreTabs = tabCount > TABS_INITIAL_LIMIT && !expanded;

  return `
    <div class="stash-group-header">
      <div class="stash-header-left">
        <div class="stash-title-block" title="双击重命名标签组">
          <svg class="group-bullet-icon" ${group.color ? `data-color="${escapeHTML(group.color)}"` : ''} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
          <h3 class="title-text">${escapeHTML(displayGroupName)}</h3>
          <button class="btn-icon-rename btn-rename-group" data-id="${safeGroupId}" type="button" aria-label="重命名此组" title="重命名此组">
            <svg class="edit-hint-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
            </svg>
          </button>
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
          <button class="stash-action-link btn-restore-all" data-id="${safeGroupId}" type="button" aria-label="还原此组全部网页">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
            <span>全部还原</span>
          </button>

          <div class="dropdown-wrapper">
            <button class="stash-action-link btn-toggle-dropdown" data-id="${safeGroupId}" type="button" aria-label="更多操作" aria-haspopup="true" aria-expanded="false">
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
}
