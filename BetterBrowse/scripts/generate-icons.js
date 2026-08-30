/**
 * @file generate-icons.js
 * @description 治愈系猫耳高清图标生成器 (Deno 原生驱动，生成 16~512px 抗锯齿 PNG 图标)
 * @encoding UTF-8
 */

import { fromFileUrl, resolve, dirname, join } from "@std/path";
import zlib from "node:zlib";
import { Buffer } from "node:buffer";

const currentDir = dirname(fromFileUrl(import.meta.url));
const projectRoot = resolve(currentDir, "..");

function crc32(buf) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  table[i] = c;
}

function createChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(len + 12);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  const crcData = chunk.subarray(4, len + 8);
  chunk.writeUInt32BE(crc32(crcData), len + 8);
  return chunk;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function isPointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function distToPolyBorder(px, py, poly) {
  let minD = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distToSegment(px, py, poly[i][0], poly[i][1], poly[j][0], poly[j][1]);
    if (d < minD) minD = d;
  }
  return minD;
}

function blendRGBA(dst, srcR, srcG, srcB, srcA) {
  const outA = srcA + dst.a * (1 - srcA);
  if (outA <= 0) return dst;
  const outR = (srcR * srcA + dst.r * dst.a * (1 - srcA)) / outA;
  const outG = (srcG * srcA + dst.g * dst.a * (1 - srcA)) / outA;
  const outB = (srcB * srcA + dst.b * dst.a * (1 - srcA)) / outA;
  dst.r = outR;
  dst.g = outG;
  dst.b = outB;
  dst.a = outA;
  return dst;
}

function sampleIcon(u, v, _size) {
  let color = { r: 0, g: 0, b: 0, a: 0 };

  const catPoly = [
    [0.15, 0.76],
    [0.15, 0.41],
    [0.23, 0.33],
    [0.23, 0.18],
    [0.39, 0.31],
    [0.50, 0.33],
    [0.61, 0.31],
    [0.77, 0.18],
    [0.77, 0.33],
    [0.85, 0.41],
    [0.85, 0.76],
    [0.70, 0.90],
    [0.30, 0.90]
  ];

  const inCat = isPointInPoly(u, v, catPoly);
  const borderDist = distToPolyBorder(u, v, catPoly);

  if (!inCat && v > 0.25 && borderDist < 0.09) {
    const shadowT = clamp(1 - borderDist / 0.09, 0, 1);
    const shadowAlpha = shadowT * shadowT * 0.22;
    blendRGBA(color, 43, 45, 66, shadowAlpha);
  }

  const strokeWidth = 0.026;
  if (inCat) {
    blendRGBA(color, 255, 255, 255, 1.0);
    if (borderDist < strokeWidth) {
      const edgeT = clamp(borderDist / strokeWidth, 0, 1);
      blendRGBA(color, 43, 45, 66, 1.0 - edgeT * 0.85);
    }
  } else if (borderDist < strokeWidth * 0.6) {
    const a = clamp(1 - borderDist / (strokeWidth * 0.6), 0, 1);
    blendRGBA(color, 43, 45, 66, a * 0.95);
  }

  if (inCat) {
    const tabLineDist = distToSegment(u, v, 0.17, 0.37, 0.83, 0.37);
    if (tabLineDist < 0.008) {
      const lineA = clamp(1 - tabLineDist / 0.008, 0, 1);
      blendRGBA(color, 237, 242, 247, lineA * 0.85);
    }

    const leftEarInner = [[0.26, 0.22], [0.25, 0.30], [0.33, 0.30]];
    if (isPointInPoly(u, v, leftEarInner)) {
      blendRGBA(color, 255, 204, 213, 1.0);
    }
    const rightEarInner = [[0.74, 0.22], [0.67, 0.30], [0.75, 0.30]];
    if (isPointInPoly(u, v, rightEarInner)) {
      blendRGBA(color, 255, 204, 213, 1.0);
    }

    function renderWarmStarDiamond(cx, cy) {
      const ex = u - cx;
      const ey = v - cy;
      const dRhombus = Math.abs(ex) / 0.075 + Math.abs(ey) / 0.115;

      if (dRhombus <= 1.0) {
        const t = clamp((ey + 0.115) / 0.23, 0, 1);
        let r = 255;
        let g = Math.round(lerp(117, 24, t));
        let b = Math.round(lerp(143, 74, t));
        blendRGBA(color, r, g, b, 1.0);

        const sx = ex;
        const sy = ey + 0.024;
        const starMetric = Math.pow(Math.abs(sx) / 0.028, 0.65) + Math.pow(Math.abs(sy) / 0.055, 0.65);
        if (starMetric <= 1.0) {
          blendRGBA(color, 255, 255, 255, 1.0);
        }

        const glintDist = Math.hypot(ex - 0.024, ey - 0.035);
        if (glintDist < 0.010) {
          blendRGBA(color, 255, 255, 255, 0.95);
        }
      } else if (dRhombus < 1.08) {
        const edgeA = clamp(1 - (dRhombus - 1.0) / 0.08, 0, 1);
        blendRGBA(color, 255, 77, 109, edgeA * 0.9);
      }
    }

    renderWarmStarDiamond(0.36, 0.58);
    renderWarmStarDiamond(0.64, 0.58);

    const leftBlushDist = Math.hypot((u - 0.24) * 1.6, v - 0.64);
    if (leftBlushDist < 0.035) {
      const blushA = clamp(1 - leftBlushDist / 0.035, 0, 1) * 0.55;
      blendRGBA(color, 255, 179, 198, blushA);
    }
    const rightBlushDist = Math.hypot((u - 0.76) * 1.6, v - 0.64);
    if (rightBlushDist < 0.035) {
      const blushA = clamp(1 - rightBlushDist / 0.035, 0, 1) * 0.55;
      blendRGBA(color, 255, 179, 198, blushA);
    }

    const mouthLeft = distToSegment(u, v, 0.46, 0.65, 0.50, 0.67);
    const mouthRight = distToSegment(u, v, 0.50, 0.67, 0.54, 0.65);
    const minMouth = Math.min(mouthLeft, mouthRight);
    if (minMouth < 0.009) {
      const a = clamp(1 - minMouth / 0.009, 0, 1);
      blendRGBA(color, 43, 45, 66, a * 0.85);
    }
  }

  return color;
}

function generateAntialiasedPNG(size) {
  const rowSize = 1 + size * 4;
  const rawData = Buffer.alloc(rowSize * size);
  const ss = size <= 32 ? 4 : (size <= 128 ? 3 : 2);
  const totalSamples = ss * ss;

  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0;

    for (let x = 0; x < size; x++) {
      let accumR = 0;
      let accumG = 0;
      let accumB = 0;
      let accumA = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const c = sampleIcon(u, v, size);
          accumR += c.r * c.a;
          accumG += c.g * c.a;
          accumB += c.b * c.a;
          accumA += c.a;
        }
      }

      const finalA = accumA / totalSamples;
      const finalR = finalA > 0 ? clamp(Math.round(accumR / accumA), 0, 255) : 0;
      const finalG = finalA > 0 ? clamp(Math.round(accumG / accumA), 0, 255) : 0;
      const finalB = finalA > 0 ? clamp(Math.round(accumB / accumA), 0, 255) : 0;

      const pixelOffset = rowOffset + 1 + x * 4;
      rawData[pixelOffset] = finalR;
      rawData[pixelOffset + 1] = finalG;
      rawData[pixelOffset + 2] = finalB;
      rawData[pixelOffset + 3] = Math.round(finalA * 255);
    }
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = createChunk("IHDR", ihdrData);

  const compressed = zlib.deflateSync(rawData);
  const idat = createChunk("IDAT", compressed);
  const iend = createChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

const iconsDir = resolve(projectRoot, "src/icons");
await Deno.mkdir(iconsDir, { recursive: true });

console.log("🚀 开始生成全尺寸温馨治愈猫耳标签图标 (16px ~ 512px)...");
for (const size of [16, 32, 48, 128, 256, 512]) {
  const pngBuf = generateAntialiasedPNG(size);
  const outPath = join(iconsDir, `icon${size}.png`);
  await Deno.writeFile(outPath, pngBuf);
  console.log(`✅ 已生成: icon${size}.png (${size}x${size}, ${pngBuf.length} 字节)`);
}
console.log("✨ 治愈系家用图标全部生成完毕！");
