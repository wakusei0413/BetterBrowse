/**
 * @file onetab-converter.js
 * @description OneTab 数据格式双向转换器（智能解析 OneTab 纯文本、OneTab 内部数据与 Better Browse 数据）
 * @encoding UTF-8
 */

export class OneTabConverter {
  /**
   * 校验并清洗 URL，支持智能补齐缺省协议头并兼容常见安全协议
   * @param {unknown} rawUrl
   * @returns {string | null}
   */
  static sanitizeUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return null;
    let url = rawUrl.trim();
    if (!url || url.length > 8192) return null;

    const lower = url.toLowerCase();
    if (
      lower.startsWith('javascript:') ||
      lower.startsWith('data:text/html') ||
      lower.startsWith('vbscript:')
    ) {
      return null;
    }

    if (url.startsWith('//')) {
      url = 'https:' + url;
    } else if (/^[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z0-9]/.test(url) && !url.includes('://')) {
      url = 'https://' + url;
    }

    try {
      const parsed = new URL(url);
      const allowedProtocols = [
        'http:',
        'https:',
        'chrome:',
        'edge:',
        'about:',
        'file:',
        'ftp:',
        'view-source:',
        'brave:',
        'vivaldi:'
      ];
      if (allowedProtocols.includes(parsed.protocol)) {
        return url;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 将 OneTab 导出的纯文本（每行 "URL | Title"，空行分隔不同组）解析为 Better Browse 标签组结构
   * @param {string} rawText - OneTab 导出文本
   * @returns {Array<{ id: string, createdAt: number, title: string, locked: boolean, starred: boolean, tabs: Array<{ id: string, url: string, title: string, favIconUrl: string, pinned: boolean }> }>}
   */
  static parseOneTabText(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];

    const lines = rawText.split(/\r?\n/);
    const rawGroupsTabs = [];
    let currentGroupTabs = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line) {
        // 遇到空行表示新标签组分界
        if (currentGroupTabs.length > 0) {
          rawGroupsTabs.push(currentGroupTabs);
          currentGroupTabs = [];
        }
        continue;
      }

      // 解析单行: "URL | Title" 或 纯 "URL"
      let url = '';
      let title = '';

      if (line.includes('|')) {
        const parts = line.split('|');
        url = parts[0].trim();
        title = parts.slice(1).join('|').trim();
      } else {
        url = line;
        title = line;
      }

      const cleanUrl = this.sanitizeUrl(url);

      if (cleanUrl) {
        let domain = '';
        try {
          domain = new URL(cleanUrl).hostname;
        } catch {
          domain = '';
        }

        currentGroupTabs.push({
          id: `tab_item_${Math.random().toString(36).substring(2, 9)}`,
          url: cleanUrl,
          title: title || cleanUrl,
          favIconUrl: domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : '',
          pinned: false
        });
      }
    }

    // 处理最后一个未闭合的组
    if (currentGroupTabs.length > 0) {
      rawGroupsTabs.push(currentGroupTabs);
    }

    // 为各组依序赋予时间递减的时间戳（首行组为最新，靠后组依次递减，确保时间倒序排列时与导出文本顺序完全一致）
    const baseTime = Date.now();
    const groups = rawGroupsTabs.map((tabs, index) => {
      const groupTime = baseTime - index * 60 * 1000;
      return this.createGroupFromTabs(tabs, groupTime);
    });

    return groups;
  }

  /**
   * 将 Better Browse 标签组列表导出为 OneTab 兼容的纯文本格式（URL | Title）
   * @param {Array<any>} groups - 标签组列表
   * @returns {string}
   */
  static exportToOneTabText(groups) {
    if (!Array.isArray(groups)) return '';
    return groups
      .map((group) => {
        if (!group.tabs || group.tabs.length === 0) return '';
        return group.tabs.map((t) => `${t.url} | ${t.title || t.url}`).join('\n');
      })
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * 生成标准标签组对象
   * @param {Array<any>} tabs
   * @param {number} [timestamp]
   */
  static createGroupFromTabs(tabs, timestamp = Date.now()) {
    const dateStr = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(timestamp));

    return {
      id: `stash_grp_${timestamp}_${Math.random().toString(36).substring(2, 7)}`,
      createdAt: timestamp,
      title: `${dateStr} 收纳 (${tabs.length} 个标签页)`,
      locked: false,
      starred: false,
      tabs: tabs
    };
  }

  /**
   * 智能多格式自动识别与解析器（自动兼容：OneTab 纯文本、OneTab 内部 JSON、Better Browse JSON）
   * @param {string} inputString - 待解析的文本或 JSON 字符串
   * @returns {{ success: boolean, groups: Array<any>, totalTabs: number, formatName: string, error?: string }}
   */
  static autoParse(inputString) {
    if (!inputString || typeof inputString !== 'string') {
      return { success: false, groups: [], totalTabs: 0, formatName: '未知', error: '输入内容为空' };
    }

    const trimmed = inputString.trim();

    // 1. 尝试作为 JSON 数据结构解析
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);

        // A. BetterBrowse 官方导出 JSON (或包含 data, groups, stashGroups, bb_stash_groups 的对象)
        let candidateGroups = null;
        if (Array.isArray(parsed.data)) {
          candidateGroups = parsed.data;
        } else if (Array.isArray(parsed.groups)) {
          candidateGroups = parsed.groups;
        } else if (Array.isArray(parsed.stashGroups)) {
          candidateGroups = parsed.stashGroups;
        } else if (Array.isArray(parsed.bb_stash_groups)) {
          candidateGroups = parsed.bb_stash_groups;
        } else if (Array.isArray(parsed) && parsed.length > 0) {
          if (Array.isArray(parsed[0].tabs)) {
            candidateGroups = parsed;
          } else if (parsed[0].url) {
            candidateGroups = [this.createGroupFromTabs(parsed)];
          }
        } else if (Array.isArray(parsed.tabs)) {
          candidateGroups = [parsed];
        }

        if (candidateGroups && Array.isArray(candidateGroups) && candidateGroups.length > 0) {
          const total = candidateGroups.reduce((sum, g) => sum + (g.tabs?.length || 0), 0);
          return {
            success: true,
            groups: candidateGroups,
            totalTabs: total,
            formatName: 'BetterBrowse 官方备份 (JSON)'
          };
        }

        // B. OneTab 内部状态 JSON（含 tabGroups 节点，真实历史时间戳精准还原）
        if (parsed.tabGroups && Array.isArray(parsed.tabGroups)) {
          const convertedGroups = parsed.tabGroups.map((grp) => {
            const tabs = (grp.tabsMeta || []).map((t) => ({
              id: `tab_item_${Math.random().toString(36).substring(2, 9)}`,
              url: t.url,
              title: t.title || t.url,
              favIconUrl: '',
              pinned: false
            }));

            const realTimestamp = typeof grp.createDate === 'number' ? grp.createDate : Date.now();
            const dateStr = new Intl.DateTimeFormat('zh-CN', {
              year: 'numeric',
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false
            }).format(new Date(realTimestamp));

            return {
              id: `stash_grp_${realTimestamp}_${Math.random().toString(36).substring(2, 7)}`,
              createdAt: realTimestamp,
              title: grp.label || `${dateStr} 收纳 (${tabs.length} 个标签页)`,
              locked: Boolean(grp.locked),
              starred: Boolean(grp.starred),
              tabs: tabs
            };
          });
          const total = convertedGroups.reduce((sum, g) => sum + g.tabs.length, 0);
          return { success: true, groups: convertedGroups, totalTabs: total, formatName: 'OneTab 内部数据 (JSON)' };
        }
      } catch {
        // 若 JSON 解析报错，自动降级至纯文本解析
      }
    }

    // 2. 作为 OneTab 经典纯文本格式解析 (URL | Title, 空行分界)
    const textGroups = this.parseOneTabText(trimmed);
    if (textGroups.length > 0) {
      const total = textGroups.reduce((sum, g) => sum + g.tabs.length, 0);
      return { success: true, groups: textGroups, totalTabs: total, formatName: 'OneTab 文本格式 (URL | 标题)' };
    }

    return {
      success: false,
      groups: [],
      totalTabs: 0,
      formatName: '未知格式',
      error: '无法识别有效链接，请确保每行为 "URL | 网页标题" 或标准 JSON 格式'
    };
  }
}

