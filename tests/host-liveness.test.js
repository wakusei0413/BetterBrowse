/**
 * @file host-liveness.test.js
 * @description 桥接宿主活性看门狗判定回归测试
 * @encoding UTF-8
 */

import { assertEquals } from "@std/assert";
import { isExtensionUnresponsive } from "../BetterBrowse/native-host/liveness.js";

const TIMEOUT = 90000;

Deno.test("宿主看门狗：空闲很久后的第一个请求不得被立即判为扩展失联", () => {
  const now = 10_000_000;
  // 宿主空闲 10 分钟（期间不发 ping，lastPongAt 停在很久以前），刚转发一个请求 2 秒
  const result = isExtensionUnresponsive({
    inflight: { forwardedAt: now - 2000 },
    lastPongAt: now - 600000,
    now,
    timeoutMs: TIMEOUT
  });
  assertEquals(result, false);
});

Deno.test("宿主看门狗：在途请求转发后超过阈值仍无 pong 才判失联", () => {
  const now = 10_000_000;
  assertEquals(isExtensionUnresponsive({ inflight: { forwardedAt: now - 91000 }, lastPongAt: now - 600000, now, timeoutMs: TIMEOUT }), true);
  assertEquals(isExtensionUnresponsive({ inflight: { forwardedAt: now - 200000 }, lastPongAt: now - 30000, now, timeoutMs: TIMEOUT }), false, "近期有 pong 说明扩展存活");
  assertEquals(isExtensionUnresponsive({ inflight: null, lastPongAt: 0, now, timeoutMs: TIMEOUT }), false, "没有在途请求不判失联");
});
