/**
 * @file crypto-util.js
 * @description 同步用 SHA-256 摘要（快照与批次完整性校验）
 * @encoding UTF-8
 */

export async function sha256Hex(text) {
  const source = String(text ?? '');
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(source);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 测试环境无 SubtleCrypto 时的确定性 FNV-1a 兜底（不用于生产完整性对抗）
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').padEnd(64, '0');
}
