# Better Browse - 智能浏览增强插件

**Better Browse** 是一款遵循 Chrome Extensions **Manifest V3** 规范的现代化智能浏览增强扩展。它采用现代简约扁平化（Flat Minimalist）设计与高可扩展的分层模块化架构，致力于为用户提供清爽、高效的链接跳转控制与基于优先级规则的智能标签页收纳体验。

---

## 🌟 核心特性

### 1. 智能链接跳转控制（核心功能）
- **三态跳转策略**：
  - 🔄 **自动模式（Auto）**：遵循网站原生逻辑，插件不干涉跳转。
  - 📌 **当前标签页（Current Tab）**：强制当前网站所有链接在当前标签页打开（自动重写 `target="_self"` 并拦截新窗口弹出）。
  - ✨ **新标签页（New Tab）**：强制当前网站所有链接在新标签页中打开（自动设置 `target="_blank"` 与安全属性 `rel="noopener noreferrer"`）。
- **作用域与灵活覆盖**：
  - **单域名独立记忆**：为特定网站（如 GitHub、知乎、微博、掘金等）单独配置偏好模式。
  - **“对所有网站生效”全局覆盖**：一键开启全局覆盖，所有网页均统一应用指定的跳转策略。
- **全动态捕获**：基于事件捕获阶段（Capture Phase）进行事件委托拦截，无缝支持 SPA 单页应用与 AJAX 异步渲染节点。

---

### 2. 智能标签页收纳引擎（多级优先级判定链）
当打开的标签页数量过多或用户手动触发时，插件自动执行 P0-P3 多级规则流水线，智能判断哪些标签保留、哪些标签收纳：

| 优先级 | 规则类型 | 触发判断条件 | 动作与处理 |
| :--- | :--- | :--- | :--- |
| **P0（最高）** | **正在播放媒体** | 标签页正播放音频或视频（`tab.audible === true`） | **跳过收纳（安全保留）** |
| **P0（最高）** | **表单输入保护** | 页面内存在获得焦点的输入框或已输入未提交内容（`textarea`/`input`/富文本） | **跳过收纳（安全保留）** |
| **P1（高）** | **最近访问与活跃** | 处于当前浏览前台或在最近 5 分钟（可自定义）内被激活过 | **跳过收纳（安全保留）** |
| **P2（中）** | **高频访问标签** | 统计最近 1 小时内切换激活的频次，排名前 20% 的常用标签 | **跳过收纳（安全保留）** |
| **P3（低）** | **固定标签页** | 固定在浏览器左侧的标签页（`tab.pinned === true`） | **跳过收纳（安全保留）** |
| **默认** | **其余闲置标签** | 未命中上述任何保留规则的标签页 | **执行收纳（安全关闭并归档）** |

---

### 3. 收纳箱与数据恢复中心
- **内置独立收纳库（默认/推荐）**：无需安装第三方插件，本地安全持久化存储。
  - 支持**一键恢复整组**、**单个标签恢复**。
  - 支持**标签搜索过滤**、**一键复制全部 URL**、**分组删除**。
- **OneTab 外部协同模式（进阶）**：支持自动探测本地 OneTab 扩展，实现跨扩展协同导入。
- **完整备份与迁移**：支持将所有收纳数据一键导出为标准 JSON 备份文件，并支持从文件或剪贴板文本导入恢复。

---

### 4. 现代简约扁平化设计
- 符合 Chrome 原生界面审美的现代扁平风格，无冗余视觉干扰。
- 自适应系统的**浅色模式（Light Mode）**与**深色模式（Dark Mode）**。

---

## 🛠️ 模块化与可扩展架构说明

项目采用高内聚、低耦合的分层架构，便于未来持续增加新 Feature：

```
BetterBrowse/
├── manifest.json                  # 扩展清单配置（Manifest V3，UTF-8）
├── package.json                   # 脚本与工程配置
├── scripts/                       # 工具脚本
│   ├── generate-icons.mjs        # 矢量与像素图标生成脚本
│   └── build-content.mjs         # 内容脚本自包含打包器
│
├── src/
│   ├── constants/                 # 全局契约与常量定义
│   │   ├── action-types.js       # 跨端通信 ActionTypes 契约常量
│   │   ├── config.js             # 默认配置、优先级与枚举定义
│   │   └── storage-keys.js       # Storage 键名命名空间
│   │
│   ├── core/                      # 核心领域逻辑层（纯 JS，无 DOM 强耦合）
│   │   ├── bus/
│   │   │   └── message-bus.js    # 统一跨端消息通讯总线
│   │   ├── storage/
│   │   │   ├── storage-adapter.js# Chrome Storage 统一适配器（含监听与合并）
│   │   │   └── migration.js      # 数据架构版本平滑迁移管理器
│   │   ├── rules/                # 智能收纳规则引擎（策略模式与责任链）
│   │   │   ├── base-rule.js      # 规则基类
│   │   │   ├── audible-rule.js   # P0 媒体播放保护规则
│   │   │   ├── form-guard-rule.js# P0 表单输入保护规则
│   │   │   ├── recent-active-rule.js # P1 最近访问保护规则
│   │   │   ├── frequency-rule.js # P2 高频访问保护规则
│   │   │   ├── pinned-rule.js    # P3 固定标签保护规则
│   │   │   └── rule-engine.js    # 规则编排与评估器
│   │   ├── stash/                # 收纳仓储与协同适配
│   │   │   ├── stash-service.js  # 收纳与恢复服务调度
│   │   │   ├── local-stash-repo.js # 本地收纳仓储（CRUD与导入导出）
│   │   │   └── onetab-adapter.js # OneTab 外部协同适配器
│   │   └── link/                 # 链接决策与域名匹配
│   │       ├── link-matcher.js   # 域名解析与跳转模式计算
│   │       └── link-service.js   # 域名跳转规则业务服务
│   │
│   ├── background/               # 后台工作线程（Service Worker）
│   │   ├── activity-tracker.js   # 标签页激活时间与频次滑动跟踪
│   │   ├── threshold-monitor.js  # 标签页数量阈值监控与系统通知
│   │   └── service-worker.js     # 后台主入口
│   │
│   ├── content/                  # 页面内容注入脚本
│   │   ├── link-interceptor.js   # 链接点击拦截器
│   │   ├── form-detector.js      # 表单状态与 Dirty 探测器
│   │   ├── content-bundle.js     # 生产环境自包含内容脚本
│   │   └── index.js              # 内容脚本源码入口
│   │
│   ├── popup/                    # 弹出控制台（极简扁平化）
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   │
│   ├── options/                  # 选项与收纳管理中心仪表盘
│   │   ├── options.html
│   │   ├── options.css
│   │   └── options.js
│   │
│   └── icons/                    # 高清图标资源 (16/32/48/128)
│       ├── icon.svg
│       ├── icon16.png
│       ├── icon32.png
│       ├── icon48.png
│       └── icon128.png
└── README.md
```

---

## 🚀 未来扩展 Feature 指南

### 1. 新增一条标签页收纳规则
在 `src/core/rules/` 目录下新建规则类，继承 `BaseRule` 并实现 `evaluate(context)` 方法：
```javascript
import { BaseRule } from './base-rule.js';
import { RulePriorities } from '../../constants/config.js';

export class DomainWhitelistRule extends BaseRule {
  constructor() {
    super({
      id: 'domainWhitelist',
      name: '白名单域名保护',
      priority: RulePriorities.P1,
      description: '保护用户特别指定的白名单域名不被收纳'
    });
  }

  async evaluate({ tab, config }) {
    if (tab.url.includes('work.corp.com')) {
      return { retain: true, reason: '处于工作白名单中', matchedRuleId: this.id };
    }
    return { retain: false };
  }
}
```
然后在 `src/core/rules/rule-engine.js` 中调用 `this.registerRule(new DomainWhitelistRule())` 即可立即生效，**原有其他规则代码零修改**。

### 2. 接入新的收纳同步后端（如 Notion / Obsidian / 书签栏）
在 `src/core/stash/` 目录下实现相应的适配器类，并在 `stash-service.js` 的 `executeStash` 中根据配置进行派发即可。

### 3. 数据 Schema 升级
当修改了存储字段时，只需在 `src/core/storage/migration.js` 中增加对应版本迁移逻辑，即可确保老用户配置无缝升级，永不丢失历史数据。

---

## 📦 安装与使用方法

1. **打开 Chrome 扩展管理界面**：
   在浏览器地址栏输入并打开：`chrome://extensions/`
2. **开启“开发者模式”**：
   勾选右上角的“开发者模式”（Developer mode）开关。
3. **加载扩展**：
   点击左上角“**加载已解压的扩展程序**”（Load unpacked），选择本项目根目录（即包含 `manifest.json` 的 `BetterBrowse` 文件夹）。
4. **固定到工具栏**：
   点击 Chrome 右上角拼图图标，将 **Better Browse** 固定到浏览器工具栏，即可随时点击弹出控制台使用！

---

## 🔧 开发与构建指令

本项目可在开发环境下直接运行，如需重新生成图标或打包自包含内容脚本，可运行以下命令：

```bash
# 生成所有分辨率图标 (16/32/48/128)
node scripts/generate-icons.mjs

# 打包自包含内容脚本
node scripts/build-content.mjs

# 或执行完整构建
npm run build
```

---

## 📄 许可协议

本项目基于 [MIT 许可证](LICENSE) 开源。

