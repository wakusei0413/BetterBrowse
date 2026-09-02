/**
 * @file link-service.js
 * @description 链接跳转控制业务服务层（处理域名偏好增删改查及全局覆盖逻辑）
 * @encoding UTF-8
 */

import { StorageKeys } from '../../constants/storage-keys.js';
import { LinkModes } from '../../constants/config.js';
import { StorageAdapter } from '../storage/storage-adapter.js';
import { IndexedDBManager } from '../storage/indexed-db.js';
import { LinkMatcher } from './link-matcher.js';

export class LinkService {
  /**
   * 获取所有已配置的域名跳转规则
   * @returns {Promise<Record<string, string>>}
   */
  static async getAllRules() {
    return await StorageAdapter.get(StorageKeys.LINK_RULES, {});
  }

  /**
   * 获取全局跳转覆盖规则
   * @returns {Promise<{ enabled: boolean, mode: string }>}
   */
  static async getGlobalRule() {
    const config = await StorageAdapter.getUserConfig();
    return config.globalLinkRule || { enabled: false, mode: LinkModes.AUTO };
  }

  /**
   * 更新全局跳转覆盖规则
   * @param {boolean} enabled - 是否全局生效
   * @param {string} mode - 全局模式 ('auto' | 'current' | 'new')
   * @returns {Promise<boolean>}
   */
  static async setGlobalRule(enabled, mode) {
    if (!Object.values(LinkModes).includes(mode)) return false;
    return await StorageAdapter.updateUserConfig({
      globalLinkRule: { enabled, mode }
    });
  }

  /**
   * 获取指定域名的当前生效模式与独立配置
   * @param {string} domain - 目标域名
   * @returns {Promise<{ domainRule: string, effectiveMode: string, isGlobalApplied: boolean }>}
   */
  static async getModeForDomain(domain) {
    const cleanDomain = domain ? domain.toLowerCase().trim() : '';
    const [rules, globalRule] = await Promise.all([
      this.getAllRules(),
      this.getGlobalRule()
    ]);

    const domainRule = rules[cleanDomain] || LinkModes.AUTO;
    const effectiveMode = LinkMatcher.resolveEffectiveMode({
      domain: cleanDomain,
      linkRules: rules,
      globalLinkRule: globalRule
    });

    return {
      domainRule,
      effectiveMode,
      isGlobalApplied: Boolean(globalRule.enabled)
    };
  }

  /**
   * 获取内容脚本所需的最小页面上下文，避免向每个框架复制完整规则表。
   * @param {string} pageUrl - 当前框架 URL
   * @returns {Promise<{ effectiveMode: string }>}
   */
  static async getPageLinkContext(pageUrl) {
    const domain = LinkMatcher.extractDomain(pageUrl);
    if (!domain) return { effectiveMode: LinkModes.AUTO };
    const { effectiveMode } = await this.getModeForDomain(domain);
    return { effectiveMode };
  }

  /**
   * 设置指定域名的独立跳转规则
   * 读-改-写序列持跨上下文写锁，防止 popup 与选项页并发写入互相覆盖
   * @param {string} domain - 目标域名
   * @param {'auto' | 'current' | 'new'} mode - 跳转模式
   * @returns {Promise<boolean>}
   */
  static async setDomainRule(domain, mode) {
    if (typeof domain !== 'string' || !domain.trim() || !Object.values(LinkModes).includes(mode)) return false;
    const candidate = domain.trim();
    const cleanDomain = LinkMatcher.extractDomain(
      candidate.includes('://') ? candidate : `https://${candidate}`
    );
    if (!cleanDomain) return false;

    return await IndexedDBManager.withWriteLock(async () => {
      const rules = await this.getAllRules();

      if (mode === LinkModes.AUTO) {
        // 自动模式下从独立字典中移除该域名记录以节省存储空间
        delete rules[cleanDomain];
      } else {
        rules[cleanDomain] = mode;
      }

      return await StorageAdapter.set(StorageKeys.LINK_RULES, rules);
    });
  }

  /**
   * 删除指定域名的规则配置
   * @param {string} domain - 待删除的域名
   * @returns {Promise<boolean>}
   */
  static async removeDomainRule(domain) {
    return await this.setDomainRule(domain, LinkModes.AUTO);
  }

  /**
   * 清空所有已设置的域名规则
   * @returns {Promise<boolean>}
   */
  static async clearAllDomainRules() {
    return await IndexedDBManager.withWriteLock(async () => {
      return await StorageAdapter.set(StorageKeys.LINK_RULES, {});
    });
  }
}

