# BetterBrowse - 智能浏览增强扩展

BetterBrowse 是一款遵循 Chrome **Manifest V3** 规范的浏览器扩展。项目采用原生 ESM JavaScript 与 Deno 2.x 工具链，无需编译打包即可直接在 Chrome 中加载运行。

核心功能包括：自定义链接跳转行为、多规则智能标签页收纳、本地 IndexedDB 存储、WebDAV 多设备同步以及面向 AI Agent 的本地桥接能力。

---

## 核心特性

### 1. 链接跳转控制
- **三态跳转策略**：
  - **自动模式（Auto）**：保持网站默认行为，不干涉跳转。
  - **当前标签页（Current Tab）**：强制目标链接在当前标签页打开（改写 `target="_self"` 并拦截新窗口弹出）。
  - **新标签页（New Tab）**：强制目标链接在新标签页打开（设置 `target="_blank"` 与 `rel="noopener noreferrer"`）。
- **作用域与覆盖**：
  - **单域名独立配置**：针对特定站点（如 GitHub、知乎、微博等）分别设置策略。
  - **全局覆盖**：开启后对所有未单独配置的网页应用统一跳转规则。
- **SPA 拦截**：在主页面世界（Main World）捕获阶段处理点击事件，拦截单页应用（如 Discourse、Vue Router、React Router）的原地路由劫持。

---

### 2. 智能标签页收纳
当打开标签页过多或手动触发收纳时，扩展按 P0~P3 规则评估标签状态，未命中的闲置标签将被归档并安全关闭：

| 优先级 | 规则名称 | 判断条件 | 处理动作 |
| :--- | :--- | :--- | :--- |
| **P0（最高）** | 正在播放媒体 | 音视频正在播放（`tab.audible === true`） | 跳过收纳（保留） |
| **P0（最高）** | 表单输入保护 | 页面内有聚焦的输入框或未提交输入内容 | 跳过收纳（保留） |
| **P1（高）** | 最近访问活跃 | 处于前台激活状态，或最近 5 分钟内被访问过（时长可配置） | 跳过收纳（保留） |
| **P2（中）** | 高频访问标签 | 统计近 1 小时激活频次，排名前 20% 的标签 | 跳过收纳（保留） |
| **P3（低）** | 固定标签页 | 已被固定在浏览器左侧（`tab.pinned === true`） | 跳过收纳（保留） |
| **默认** | 其余闲置标签 | 未命中上述规则的普通标签 | 归档进收纳组并关闭 |

- **阶梯式降级**：若收纳后标签数仍超过设定阈值，系统会逐级缩短保护窗口与高频比例；若仍超标，最终仅保留硬性保护标签（媒体、表单、前台与固定标签）。

---

### 3. 收纳箱与数据管理
- **本地持久化**：采用 IndexedDB 作为权威存储，支持分批事务与跨上下文写锁，保证大量数据读写稳定。
- **分组与条目操作**：
  - 支持整组恢复、单个标签恢复、实时检索过滤与批量复制 URL。
  - 支持分组星标、锁定（防误删）、重命名与拖拽排序。
- **常驻首位守护**：可将收纳箱固定在窗口第一位，防止关闭最后一个标签页时浏览器直接退出。
- **快捷菜单**：提供右键菜单快速打开收纳箱、收纳当前窗口或收纳左侧/右侧标签页。
- **导入与导出**：
  - 兼容 OneTab 纯文本（`URL | Title`）与 JSON 数据互导。
  - 导入时自动补全缺省协议，自动过滤非法伪协议与格式异常项。
  - 支持全量配置与收纳数据的 JSON 备份与还原。

---

### 4. 多设备 WebDAV 同步
- 支持标准 HTTPS WebDAV 协议，兼容 Nextcloud、坚果云及常见云盘 WebDAV 服务。
- 采用基于操作日志（Outbox）与字段级合并（Merge）的同步机制，支持多设备增量同步、冲突检测与快照归档。
- 敏感凭据仅保存在本地设备，不参与云端同步与导出。

---

### 5. AI Agent 本地桥接
- 提供 Native Messaging 本地宿主程序与命令行客户端（`bb-bridge-client.js`），支持本机 AI Agent 读取收纳箱、操作条目、管理规则与配置。
- 人机能力对等，所有 AI 调用复用核心处理链路，高危操作（如删除、清空）强制要求确认位校验。

---

## 技术架构与目录结构

- **语言标准**：原生 JavaScript（ES2022+ / 原生 ESM）
- **工具链与测试**：Deno 2.x 原生驱动
- **测试框架**：`Deno.test`

```
BetterBrowse/
├── .gitignore                     # Git 忽略配置
├── deno.json                      # 根工作区 Deno 配置文件
│
├── skills/                        # AI Agent 技能与桥接客户端
│   └── better-browse/
│       ├── SKILL.md               # Agent 技能入口与说明
│       ├── scripts/               # 桥接客户端脚本 (bb-bridge-client.js)
│       └── references/            # 协议与排障文档
│
└── BetterBrowse/
    ├── deno.json                  # Deno 任务配置
    ├── manifest.json              # Chrome Manifest V3 配置
    ├── native-host/               # AI 桥接本地宿主程序与安装脚本
    ├── scripts/                   # 打包与代码校验辅助脚本
    ├── src/                       # 扩展源码（Chrome 直接加载）
    │   ├── constants/             # 常量、动作类型与配置定义
    │   ├── core/                  # 核心业务逻辑（存储、规则引擎、收纳仓储、WebDAV 同步）
    │   ├── background/            # 后台 Service Worker（生命周期、AI 桥接、活跃度追踪）
    │   ├── content/               # 内容脚本（链接拦截与表单探测）
    │   ├── popup/                 # 扩展弹窗界面
    │   └── options/               # 选项与收纳管理中心
    └── tests/                     # 自动化测试套件
```

---

## 常用命令

项目使用 Deno 运行辅助脚本与测试：

```bash
# 运行全套自动化测试
deno task test

# 执行代码规范与完整性校验
deno task verify

# 重新打包内容脚本 (修改 src/content/ 源码后执行)
deno task bundle

# 重新生成扩展图标
deno task icons

# 仅在跨组件通信契约发生不兼容变动时递增内部 API 版本
deno task api-version-bump

# 安装 / 卸载 AI 桥接本地宿主
deno task ai-host-install --ext-id=<扩展ID>
deno task ai-host-uninstall
```

---

## 安装与加载

1. 打开 Chrome 浏览器，在地址栏访问 `chrome://extensions/`。
2. 开启页面右上角的 **开发者模式**。
3. 点击左上角的 **加载已解压的扩展程序**。
4. 选择项目中的 **`BetterBrowse/BetterBrowse`** 目录（包含 `manifest.json` 的子文件夹）。
5. 在工具栏中固定 **BetterBrowse** 即可开始使用。

---

## 许可协议

本项目基于 [MIT 许可证](LICENSE) 开源。
