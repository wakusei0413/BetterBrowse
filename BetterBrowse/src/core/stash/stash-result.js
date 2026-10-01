/**
 * @file stash-result.js
 * @description 收纳结果的统一用户提示文案（弹窗、时间线等人类界面共用）
 * @encoding UTF-8
 */

/**
 * 把 EXECUTE_STASH 的两层响应（消息总线 + 收纳服务）转换为可展示的结果。
 * 服务层失败、跳过与"确实没有可收纳网页"必须区分开：笼统提示"没有可收纳"会掩盖写入失败等真实原因。
 * @param {{ success?: boolean, error?: string, data?: { success?: boolean, stashedCount?: number, note?: string, error?: string } }} res
 * @returns {{ ok: boolean, stashedCount: number, message: string }}
 */
export function describeStashResult(res) {
  if (!res?.success) {
    return { ok: false, stashedCount: 0, message: res?.error || '收纳失败' };
  }
  const data = res.data || {};
  const stashedCount = Number(data.stashedCount) || 0;
  if (data.success === false) {
    return { ok: false, stashedCount, message: data.error || data.note || '收纳失败' };
  }
  if (stashedCount > 0) {
    return { ok: true, stashedCount, message: data.note || `已收纳 ${stashedCount} 个标签页` };
  }
  return { ok: true, stashedCount: 0, message: data.note || '当前窗口没有可收纳的网页' };
}
