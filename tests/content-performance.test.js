/**
 * @file content-performance.test.js
 * @description 内容脚本注入范围、双层打包、自动休眠与框架消息回归测试
 * @encoding UTF-8
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildContentBundle, buildFrameContentBundle } from "../BetterBrowse/scripts/build-content.js";
import { MessageBus } from "../BetterBrowse/src/core/bus/message-bus.js";
import { LinkService } from "../BetterBrowse/src/core/link/link-service.js";
import { LinkModes } from "../BetterBrowse/src/constants/config.js";
import { LinkInterceptor } from "../BetterBrowse/src/content/link-interceptor.js";
import { createActionHandlers } from "../BetterBrowse/src/background/action-handlers.js";
import { ActionTypes } from "../BetterBrowse/src/constants/action-types.js";

const manifestUrl = new URL("../BetterBrowse/manifest.json", import.meta.url);

function installContentGlobals() {
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
    chrome: globalThis.chrome,
    MutationObserver: globalThis.MutationObserver,
    Node: globalThis.Node,
    CustomEvent: globalThis.CustomEvent
  };
  const documentCalls = { query: 0, hoverAdds: 0 };
  globalThis.window = {
    location: { hostname: "frame.example", href: "https://frame.example/path" },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {}
  };
  globalThis.document = {
    body: {},
    documentElement: { setAttribute() {} },
    addEventListener(type) {
      if (type === "mouseover") documentCalls.hoverAdds += 1;
    },
    removeEventListener() {},
    querySelectorAll() {
      documentCalls.query += 1;
      return [];
    }
  };
  globalThis.chrome = {
    runtime: { id: "test", lastError: null, sendMessage() {} }
  };
  globalThis.Node = { ELEMENT_NODE: 1 };
  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  return {
    documentCalls,
    restore() {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  };
}

Deno.test("Manifest 仅向 HTTP(S) 注入，并区分顶层完整 bundle 与 iframe 轻量 bundle", async () => {
  const manifest = JSON.parse(await Deno.readTextFile(manifestUrl));
  const expectedMatches = ["http://*/*", "https://*/*"];
  assertEquals(manifest.host_permissions, expectedMatches);
  assertEquals(manifest.content_scripts.length, 3);
  for (const script of manifest.content_scripts) assertEquals(script.matches, expectedMatches);

  const mainWorld = manifest.content_scripts.find((item) => item.world === "MAIN");
  const full = manifest.content_scripts.find((item) => item.js.includes("src/content/content-bundle.js"));
  const frame = manifest.content_scripts.find((item) => item.js.includes("src/content/frame-content-bundle.js"));
  assertEquals(mainWorld.all_frames, true);
  assertEquals(full.all_frames, false);
  assertEquals(frame.all_frames, true);
  assertEquals(manifest.permissions.includes("webNavigation"), true);
});

Deno.test("构建器生成完整与轻量两个独立 bundle", async () => {
  const full = await buildContentBundle();
  const frame = await buildFrameContentBundle();
  assertStringIncludes(full, "countdown-banner.js");
  assertStringIncludes(full, "runtime-logger.js");
  if (frame.includes("countdown-banner.js")) throw new Error("iframe bundle 不应包含倒计时卡片");
  if (frame.includes("runtime-logger.js")) throw new Error("iframe bundle 不应包含运行日志");
  assertStringIncludes(frame, "window.top === window.self");
  assertStringIncludes(frame, "frame-index.js");
});

Deno.test("LinkInterceptor 自动模式不扫描、不监听悬浮、不启动 DOM 观察器", () => {
  const env = installContentGlobals();
  let observerCreated = 0;
  globalThis.MutationObserver = class {
    constructor() { observerCreated += 1; }
    observe() {}
    disconnect() {}
  };
  try {
    const interceptor = new LinkInterceptor();
    interceptor.effectiveMode = LinkModes.AUTO;
    interceptor.applyModeResources({ initial: true });
    assertEquals(env.documentCalls.query, 0);
    assertEquals(env.documentCalls.hoverAdds, 0);
    assertEquals(observerCreated, 0);
  } finally {
    env.restore();
  }
});

Deno.test("LinkInterceptor MutationObserver 只处理 addedNodes", () => {
  const env = installContentGlobals();
  let observerCallback;
  globalThis.MutationObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  };
  try {
    const interceptor = new LinkInterceptor();
    interceptor.effectiveMode = LinkModes.NEW;
    const patched = [];
    interceptor.patchAddedNode = (node) => patched.push(node.id);
    interceptor.startDOMObserver();
    observerCallback([
      { addedNodes: [{ id: "a" }, { id: "b" }], removedNodes: [{ id: "旧节点" }] },
      { addedNodes: [{ id: "c" }] }
    ]);
    assertEquals(patched, ["a", "b", "c"]);
    assertEquals(env.documentCalls.query, 0);
  } finally {
    env.restore();
  }
});

Deno.test("LinkInterceptor 优先消费最小 effectiveMode 响应", async () => {
  const env = installContentGlobals();
  globalThis.chrome.runtime.sendMessage = (_message, callback) => callback({
    success: true,
    data: { effectiveMode: LinkModes.NEW }
  });
  try {
    const interceptor = new LinkInterceptor();
    await interceptor.refreshRulesCache();
    assertEquals(interceptor.getEffectiveMode(), LinkModes.NEW);
  } finally {
    env.restore();
  }
});

Deno.test("LinkService 最小页面上下文只返回 effectiveMode", async () => {
  const original = LinkService.getModeForDomain;
  try {
    LinkService.getModeForDomain = async (domain) => {
      assertEquals(domain, "sub.example.com");
      return { domainRule: LinkModes.NEW, effectiveMode: LinkModes.NEW, isGlobalApplied: false };
    };
    assertEquals(
      await LinkService.getPageLinkContext("https://sub.example.com/frame"),
      { effectiveMode: LinkModes.NEW }
    );
  } finally {
    LinkService.getModeForDomain = original;
  }
});

Deno.test("GET_PAGE_LINK_CONTEXT 优先使用 sender.url 并只返回 effectiveMode", async () => {
  const original = LinkService.getPageLinkContext;
  let seenUrl = "";
  LinkService.getPageLinkContext = async (url) => {
    seenUrl = url;
    return { effectiveMode: LinkModes.CURRENT };
  };
  try {
    const handlers = createActionHandlers({
      stashService: {},
      activityTracker: { getStats: () => ({}) },
      thresholdMonitor: {},
      broadcastToTabs: async () => {},
      aiBridge: { getStatusSummary: () => ({}), onConfigUpdated: () => {} }
    });
    const result = await handlers[ActionTypes.GET_PAGE_LINK_CONTEXT](
      {},
      { url: "https://iframe.example/path", tab: { url: "https://top.example/" } }
    );
    assertEquals(seenUrl, "https://iframe.example/path");
    assertEquals(result, { effectiveMode: LinkModes.CURRENT });
  } finally {
    LinkService.getPageLinkContext = original;
  }
});

Deno.test("MessageBus.sendToFrame 将 frameId 传给 chrome.tabs.sendMessage", async () => {
  const originalChrome = globalThis.chrome;
  let captured;
  globalThis.chrome = {
    runtime: { lastError: null },
    tabs: {
      sendMessage(tabId, message, options, callback) {
        captured = { tabId, message, options };
        callback({ success: true, data: "ok" });
      }
    }
  };
  try {
    const response = await MessageBus.sendToFrame(42, 7, "CHECK_FORM_INPUT", { sample: true }, 500);
    assertEquals(captured, {
      tabId: 42,
      message: { action: "CHECK_FORM_INPUT", payload: { sample: true } },
      options: { frameId: 7 }
    });
    assertEquals(response, { success: true, data: "ok" });
    assertEquals((await MessageBus.sendToFrame(42, -1, "PING")).success, false);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
