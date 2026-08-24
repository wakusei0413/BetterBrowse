# Better Browse - AI Agent 协同开发与架构指南 (AGENTS.md)

本文档专为后续参与本项目维护、重构与功能迭代的 **AI Agent（以及人类开发者）** 提供系统性的项目全景说明、底层架构设计、技术约束、规则扩展规范与开发防坑指南。

---

## 📌 1. 项目概览与硬性约束

- **项目名称**：Better Browse（智能浏览增强插件）
- **规范标准**：Chrome Extensions **Manifest V3**
- **当前版本**：`0.0.1`
- **语言与编码**（⚠️ **必须严格遵守，绝对不可违背**）：
  1. **全量简体中文**：所有源代码注释、JSDoc 函数说明、UI 界面展示文本、错误提示及文档，**一律使用标准的简体中文**。
  2. **UTF-8 编码**：所有文件必须采用无 BOM 的标准 **UTF-8** 编码，杜绝任何平台乱码。
- **设计风格**：**现代简约扁平化（Flat Minimalist）**，包含三段式滑动拉杆（左: 当前标签 / 中: 自动模式 / 右: 新标签页），与 Chrome 原生 UI 深度融合，去除厚重的视觉噪音，自适应深色（Dark）/ 浅色（Light）模式。
---

## 🏗️ 2. 系统分层架构与模块全景

项目自第一天起即推行 **“高内聚、低耦合、面向接口、插件化/策略模式”** 的分层设计：

```
BetterBrowse/
├── manifest.json                  # Manifest V3 清单配置
├── package.json                   # 项目元数据与构建指令
│
├── scripts/                       # 自动化辅助工具
│   ├── generate-icons.mjs        # 矢量与像素图标生成器
│   ├── build-content.mjs         # 内容脚本打包器 (编译为自包含 bundle)
│   └── verify-code.mjs           # 代码规范、文件完整性与编码校验器
│
└── src/
    ├── constants/                 # 全局常量契约层
    │   ├── action-types.js       # 跨端通信 ActionTypes 契约
    │   ├── config.js             # 默认配置、优先级定义与业务常量
    │   └── storage-keys.js       # Storage 键名命名空间
    │
    ├── core/                      # 核心业务领域层 (纯 JS 逻辑，无 DOM 强依赖)
    │   ├── bus/
    │   │   └── message-bus.js    # 统一跨端消息通讯总线 (强类型、安全错误处理)
    │   ├── storage/
    │   │   ├── storage-adapter.js# Chrome Storage 统一适配器 (local/sync, 变化监听, 默认值合并)
    │   │   └── migration.js      # 数据架构版本迁移器 (保障 Schema 升级向后兼容)
    │   ├── rules/                # 智能收纳规则引擎 (责任链 + 策略模式)
    │   │   ├── base-rule.js      # 规则抽象基类
    │   │   ├── audible-rule.js   # P0 媒体播放保护规则
    │   │   ├── form-guard-rule.js# P0 表单输入保护规则
    │   │   ├── recent-active-rule.js # P1 最近访问保护规则
    │   │   ├── frequency-rule.js # P2 高频访问保护规则 (Top 20%)
    │   │   ├── pinned-rule.js    # P3 固定标签保护规则
    │   │   └── rule-engine.js    # 规则编排与全量标签评估器
    │   ├── stash/                # 标签页收纳与持久化仓储
    │   │   ├── stash-service.js  # 收纳与恢复服务主调度
    │   │   ├── local-stash-repo.js # 本地独立收纳仓储 (CRUD、搜索、星标、锁定、导入导出)
    │   │   └── onetab-converter.js # OneTab 数据格式双向转换器 (支持纯文本与内部格式无缝互导)
    │       └── link-service.js   # 链接跳转规则增删改查业务服务
    │
    ├── background/               # 后台生命周期与调度 (Service Worker)
    │   ├── activity-tracker.js   # 标签页激活时间与 1 小时滑动窗口频次统计
    │   ├── threshold-monitor.js  # 标签页数量阈值监控与桌面通知
    │   └── service-worker.js     # 后台总入口 (装配模块、监听事件)
    │
    ├── content/                  # 网页端内容脚本 (双层世界防御体系)
    │   ├── main-world-bridge.js  # 主页面世界 (Main World) 脚本，拦截 SPA 框架路由，支持 Speculation Rules
    │   ├── link-interceptor.js   # 隔离世界 (Isolated World) 拦截器
    │   ├── form-detector.js      # 表单焦点与未保存输入探测器
    │   ├── content-bundle.js     # 生产环境自包含内容脚本
    │   └── index.js              # 内容脚本源码入口
    │
    ├── popup/                    # 弹出控制台 (扁平化 UI)
    │   ├── popup.html
    │   ├── popup.css
    │   └── popup.js
    │
    ├── options/                  # 选项与收纳管理中心仪表盘 (组件化设计)
    │   ├── options.html
    │   ├── options.css
    │   └── options.js
    │
    └── icons/                    # 高清图标资源 (16/32/48/128)
```

---

## 🔄 3. 关键工作流与底层交互机制

### 3.1 智能链接跳转控制流 (含 SPA 拦截与预渲染)

```
[用户在网页点击超链接 / 鼠标悬浮]
  │
  ├── 悬浮阶段 (Hover) ──► 触发 Speculation Rules 预渲染与 Prefetch 预加载
  │
  ▼
【主页面世界 (Main World)】(main-world-bridge.js)
  │
  ├── 1. 捕获阶段拦截左键点击，查找目标超链接 (支持 tr.topic-list-item / a.title)
  ├── 2. 若模式为 'new'：
  │      - 执行 event.preventDefault() 与 event.stopImmediatePropagation() 
  │        (彻底切断 Discourse / Vue Router / React 的 SPA 原地路由劫持)
  │      - 派发 CustomEvent('__BETTER_BROWSE_OPEN_NEW_TAB__', { detail: { url } })
  │
  ▼
【隔离世界 (Isolated World)】(link-interceptor.js)
  │
  └── 3. 捕获 CustomEvent，通过 MessageBus.sendToBackground(ActionTypes.OPEN_TAB_BACKGROUND)
  │
  ▼
【后台服务 (Service Worker)】(service-worker.js)
  │
  └── 4. 提取 sender.tab 信息：
         - 设置 index: sender.tab.index + 1 (紧邻在原标签页右侧打开)
         - 设置 openerTabId: sender.tab.id (建立父子关联，关闭后自动切回原标签页)
         - 调用 chrome.tabs.create() 创建并激活新标签页
```

### 3.2 智能标签页收纳规则判定流 (P0 ~ P3)

```
[触发收纳 (手动点击 或 超过阈值自动提醒)]
  │
  ▼
【规则编排引擎】(RuleEngine.evaluateTabs)
  │
  ├── P0: AudibleRule ───────► tab.audible === true? ──────────────► [保留]
  ├── P0: FormGuardRule ─────► 内容脚本检测 input/textarea 编辑中? ──► [保留]
  ├── P1: RecentActiveRule ──► tab.active || 最近 5 分钟激活过? ───► [保留]
  ├── P2: FrequencyRule ─────► 1小时内激活频次处于前 20%? ─────────► [保留]
  ├── P3: PinnedRule ────────► tab.pinned === true? ───────────────► [保留]
  │
  └── 其余所有闲置标签页 ──────────────────────────────────────────► [归档进收纳组 & 安全关闭]
```

---

## 🚀 4. AI Agent 扩展开发指南（零侵入式加 Feature）

### 4.1 如何新增一条智能收纳保留规则？

1. 在 `src/core/rules/` 目录下新建规则文件，继承 `BaseRule`：
   ```javascript
   import { BaseRule } from './base-rule.js';
   import { RulePriorities } from '../../constants/config.js';

   export class CustomWorkspaceRule extends BaseRule {
     constructor() {
       super({
         id: 'customWorkspace',
         name: '特定工作区保护',
         priority: RulePriorities.P1, // 指定优先级 P0-P3
         description: '保护特定工作区域名下的标签页不被自动收纳'
       });
     }

     async evaluate({ tab, config }) {
       // 实现业务判定逻辑
       if (tab.url?.includes('my-work-domain.com')) {
         return {
           retain: true,
           reason: '属于重点工作区页面',
           matchedRuleId: this.id
         };
       }
       return { retain: false };
     }
   }
   ```
2. 在 [src/core/rules/rule-engine.js](file:///c:/Users/wakusei/Desktop/BetterBrowse/src/core/rules/rule-engine.js) 中实例化并注册：
   ```javascript
   this.registerRule(new CustomWorkspaceRule());
   ```
3. 在 [src/constants/config.js](file:///c:/Users/wakusei/Desktop/BetterBrowse/src/constants/config.js) 的 `DefaultConfig.rulesEnabled` 中增加对应开关，并在设置面板挂载 UI。
4. **原有规则代码完全无需任何变动**。

---

### 4.2 如何接入新的收纳同步后端（如 Notion / Obsidian / 书签栏）？

1. 在 `src/core/stash/` 下创建新的仓储适配器类（如 `notion-adapter.js` 或 `bookmarks-adapter.js`）。
2. 在 [src/core/stash/stash-service.js](file:///c:/Users/wakusei/Desktop/BetterBrowse/src/core/stash/stash-service.js) 的 `executeStash` 中根据用户配置进行分支派发。

---

### 4.3 如何进行数据存储架构平滑升级？

1. 当修改了存储数据结构或追加了字段时，将 `src/constants/config.js` 中的 `CURRENT_SCHEMA_VERSION` 递增（例如从 `1` 改为 `2`）。
2. 在 [src/core/storage/migration.js](file:///c:/Users/wakusei/Desktop/BetterBrowse/src/core/storage/migration.js) 中编写针对性的版本迁移逻辑：
   ```javascript
   if (currentVersion < 2) {
     // 执行从 v1 到 v2 的数据结构转换与补充字段写入
   }
   ```
3. 扩展启动时会自动运行迁移，保障老用户无感升级。

---

## 🛠️ 5. 构建、打包与自检指令

在完成任何代码修改后，**必须依次运行以下命令验证**：

```bash
# 1. 重新打包自包含内容脚本 (每次修改 content 相关代码后必须执行)
node scripts/build-content.mjs

# 2. 运行静态规范、UTF-8 编码与文件完整性校验 (必须全部 PASS)
node scripts/verify-code.mjs

# 3. 如有需要可一键全量构建
npm run build
```

---

## ⚠️ 6. Agent 开发避坑指南（Gotchas）

1. **SPA 框架与单页面路由拦截**：
   - 任何涉及阻止单页跳转的行为，必须在 `src/content/main-world-bridge.js` 的**主世界捕获阶段**完成，绝对不能只在隔离世界（Isolated World）里调用 `event.stopPropagation()`，否则无法阻止页面的 Ember/Vue/React 路由。
2. **内容脚本打包更新**：
   - 浏览器直接加载的是 `src/content/content-bundle.js`，修改了 `src/content/` 源代码后**务必执行 `node scripts/build-content.mjs`**。
3. **标签页定位**：
   - 创建新标签页时，务必使用 `sender.tab.index + 1` 与 `openerTabId: sender.tab.id`，保障新标签页紧邻右侧打开并在关闭时切回原标签。
4. **编码要求**：
   - 任何新增文件必须以 **UTF-8** 格式保存，且代码注释与文本使用**简体中文**。

