/**
 * @file liveness.js
 * @description 宿主活性看门狗的判定逻辑（纯函数，便于单独测试）
 * @encoding UTF-8
 */

/**
 * 在途请求期间扩展是否已失联。
 * 宿主只在有在途请求时才发 ping，空闲期间 lastPongAt 不会刷新；
 * 因此必须从「上次 pong」与「本请求转发时刻」中较晚的一个开始计时，
 * 否则空闲超过阈值后的第一个慢请求会在下一次维护检查时被误判失联，宿主随即退出。
 * @param {{ inflight: { forwardedAt: number } | null, lastPongAt: number, now: number, timeoutMs: number }} state
 * @returns {boolean}
 */
export function isExtensionUnresponsive({ inflight, lastPongAt, now, timeoutMs }) {
  if (!inflight) return false;
  const since = Math.max(Number(lastPongAt) || 0, Number(inflight.forwardedAt) || 0);
  return now - since > timeoutMs;
}
