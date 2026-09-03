# 内容脚本维护速查

内容脚本不是源码直出：Chrome 加载 `src/content/content-bundle.js`（顶层完整能力）与 `frame-content-bundle.js`（iframe 轻量能力）。修改 `src/content/` 或其依赖常量后必须执行 `deno task bundle`，可先用 `deno task bundle:check` 检查是否过期。

## 不可省略的约束

- SPA 路由必须在 `main-world-bridge.js` 主世界捕获阶段拦截；隔离世界的冒泡阶段无法阻止 Discourse、Vue 或 React 路由。
- `auto` 模式完全休眠：不绑定 hover、不扫全页、不启动 body MutationObserver、不替换 `window.open`；恢复 auto 时按 `data-bb-orig-target` / `data-bb-orig-rel` 精确还原。
- 非 auto 模式的 MutationObserver 只处理 `addedNodes`，不得再次整页 `querySelectorAll('a[href]')`。
- 顶层 bundle 承载倒计时、日志和完整链接能力；iframe bundle 只承载表单探测、模式同步与点击拦截。倒计时只投递顶层 `frameId: 0`。
- 后台读取跳转模式时使用 `sender.url`，不能用 `sender.tab.url`，否则跨域 iframe 会继承顶层规则。
- 表单保护必须聚合标签页所有 HTTP(S) frame；任一 frame 有输入或探测失败都保留标签。
- 内容脚本禁止直读 `chrome.storage` / IndexedDB；通过后台消息取最小字段，`GET_PAGE_LINK_CONTEXT` 只返回 `{ effectiveMode }`。

## 修改后的同步清单

1. `scripts/build-content.js` 的 `BUNDLE_SPECS`；
2. `manifest.json` 的顶层/iframe 注入声明；
3. `scripts/verify-code.js` 的源文件与产物校验（并运行 `deno task bundle:check`）。
