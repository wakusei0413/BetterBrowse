/**
 * @file link-matcher.js
 * @description 链接与域名匹配器（提供主机名提取、有效跳转模式判定、子域名匹配及特殊协议过滤）
 * @encoding UTF-8
 */

import { LinkModes } from '../../constants/config.js';

export class LinkMatcher {
  /**
   * 从 URL 中安全提取规范化域名（小写，不带端口号与协议）
   * @param {string} rawUrl - 原始链接
   * @returns {string} 提取的主机名（如 "github.com"），若无法解析则返回空字符串
   */
  static extractDomain(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      // 过滤特殊非 HTTP/HTTPS 协议（例如 chrome://, javascript:, mailto:）
      if (!/^https?:\/\//i.test(rawUrl)) {
        if (rawUrl.startsWith('//')) {
          rawUrl = 'https:' + rawUrl;
        } else {
          return '';
        }
      }
      const parsed = new URL(rawUrl);
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * 检查 URL 是否为可进行跳转拦截的合法网页
   * @param {string} url - 目标链接
   * @returns {boolean}
   */
  static isInterceptionAllowed(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed || trimmed === '#' || trimmed.startsWith('#') || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
    const protocolMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
    return !protocolMatch || /^https?:$/i.test(`${protocolMatch[1]}:`);
  }

  /**
   * 根据当前域名设置与全局规则，计算当前链接最终生效的跳转模式（支持智能子域名匹配）
   * @param {Object} params
   * @param {string} params.domain - 当前页面域名
   * @param {Record<string, string>} params.linkRules - 域名规则字典
   * @param {{ enabled: boolean, mode: string }} params.globalLinkRule - 全局规则配置
   * @returns {'auto' | 'current' | 'new'} 最终生效模式
   */
  static resolveEffectiveMode({ domain, linkRules = {}, globalLinkRule = {} }) {
    // 1. 若开启了“对所有网站生效”全局覆盖开关，则直接优先使用全局模式
    if (globalLinkRule && globalLinkRule.enabled && globalLinkRule.mode) {
      return globalLinkRule.mode;
    }

    if (!domain) {
      return LinkModes.AUTO;
    }

    const cleanDomain = domain.toLowerCase().trim();

    // 2. 精确匹配当前域名（如 "www.baidu.com"）
    if (linkRules[cleanDomain]) {
      return linkRules[cleanDomain];
    }

    // 3. 智能兼容：去掉 www. 前缀匹配（如 www.baidu.com -> baidu.com）
    if (cleanDomain.startsWith('www.')) {
      const rootDomain = cleanDomain.slice(4);
      if (linkRules[rootDomain]) {
        return linkRules[rootDomain];
      }
    }

    // 4. 智能兼容：加上 www. 前缀匹配（如 baidu.com -> www.baidu.com）
    const withWww = 'www.' + cleanDomain;
    if (linkRules[withWww]) {
      return linkRules[withWww];
    }

    // 5. 逐级向上递归父级主域名匹配（例如 a.b.c.qq.com -> b.c.qq.com -> c.qq.com -> qq.com）
    const parts = cleanDomain.split('.');
    while (parts.length > 2) {
      parts.shift();
      const parentDomain = parts.join('.');
      if (linkRules[parentDomain]) {
        return linkRules[parentDomain];
      }
    }

    // 6. 默认回退至自动模式
    return LinkModes.AUTO;
  }
}
