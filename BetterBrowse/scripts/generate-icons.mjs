import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// --- PNG CRC32 & 基础数据块生成工具 ---
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
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  const crcData = chunk.subarray(4, len + 8);
  chunk.writeUInt32BE(crc32(crcData), len + 8);
  return chunk;
}

// --- 数学与几何辅助函数 ---
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 射线法：多边形内部检测
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

// 点到线段距离
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// 点到多边形边界的距离
function distToPolyBorder(px, py, poly) {
  let minD = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distToSegment(px, py, poly[i][0], poly[i][1], poly[j][0], poly[j][1]);
    if (d < minD) minD = d;
  }
  return minD;
}

// RGBA 颜色混合 (Over 操作)
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

/**
 * 采样单个亚像素坐标 (u, v) 在 [0, 1] 范围内的颜色
 * 温馨治愈家用风：对称和谐的猫耳标签与草莓晶钻眼 (纯透明底，视网膜级锐利)
 */
function sampleIcon(u, v, size) {
  let color = { r: 0, g: 0, b: 0, a: 0 };

  // 1. 对称优雅的猫耳标签外轮廓多边形
  const catPoly = [
    [0.15, 0.76], // 左下弧起点
    [0.15, 0.41], // 左侧竖边
    [0.23, 0.33], // 左肩转折
    [0.23, 0.18], // 左耳尖
    [0.39, 0.31], // 左耳窝
    [0.50, 0.33], // 额头中心微弧
    [0.61, 0.31], // 右耳窝
    [0.77, 0.18], // 右耳尖
    [0.77, 0.33], // 右肩转折
    [0.85, 0.41], // 右侧竖边
    [0.85, 0.76], // 右下弧起点
    [0.70, 0.90], // 底部右圆角
    [0.30, 0.90]  // 底部左圆角
  ];

  const inCat = isPointInPoly(u, v, catPoly);
  const borderDist = distToPolyBorder(u, v, catPoly);

  // 柔和舒适微投影
  if (!inCat && v > 0.25 && borderDist < 0.09) {
    const shadowT = clamp(1 - borderDist / 0.09, 0, 1);
    const shadowAlpha = shadowT * shadowT * 0.22;
    blendRGBA(color, 43, 45, 66, shadowAlpha);
  }

  // 主体纯白温润填充与深炭灰/暖深蓝高对比边框 (#2b2d42)
  const strokeWidth = 0.026;
  if (inCat) {
    // 纯白本体
    blendRGBA(color, 255, 255, 255, 1.0);

    // 内部温和边框
    if (borderDist < strokeWidth) {
      const edgeT = clamp(borderDist / strokeWidth, 0, 1);
      blendRGBA(color, 43, 45, 66, 1.0 - edgeT * 0.85);
    }
  } else if (borderDist < strokeWidth * 0.6) {
    // 外部抗锯齿平滑边缘
    const a = clamp(1 - borderDist / (strokeWidth * 0.6), 0, 1);
    blendRGBA(color, 43, 45, 66, a * 0.95);
  }

  if (inCat) {
    // 2. 极简标签顶栏分割线
    const tabLineDist = distToSegment(u, v, 0.17, 0.37, 0.83, 0.37);
    if (tabLineDist < 0.008) {
      const lineA = clamp(1 - tabLineDist / 0.008, 0, 1);
      blendRGBA(color, 237, 242, 247, lineA * 0.85); // #edf2f7
    }

    // 左右耳内侧温润柔粉三角
    const leftEarInner = [[0.26, 0.22], [0.25, 0.30], [0.33, 0.30]];
    if (isPointInPoly(u, v, leftEarInner)) {
      blendRGBA(color, 255, 204, 213, 1.0); // #ffccd5
    }
    const rightEarInner = [[0.74, 0.22], [0.67, 0.30], [0.75, 0.30]];
    if (isPointInPoly(u, v, rightEarInner)) {
      blendRGBA(color, 255, 204, 213, 1.0);
    }

    // 3. ✨ 治愈系草莓晶钻眼 (Warm Anime Star-Diamond)
    function renderWarmStarDiamond(cx, cy) {
      const ex = u - cx;
      const ey = v - cy;
      // 优雅圆润菱形方程
      const dRhombus = Math.abs(ex) / 0.075 + Math.abs(ey) / 0.115;

      if (dRhombus <= 1.0) {
        // 温润草莓粉渐变: #ff758f -> #ff4d6d -> #c9184a
        const t = clamp((ey + 0.115) / 0.23, 0, 1);
        let r = 255;
        let g = Math.round(lerp(117, 24, t));
        let b = Math.round(lerp(143, 74, t));
        blendRGBA(color, r, g, b, 1.0);

        // 主纯白四芒璀璨星光 (✦ Sparkle)
        const sx = ex;
        const sy = ey + 0.024;
        const starMetric = Math.pow(Math.abs(sx) / 0.028, 0.65) + Math.pow(Math.abs(sy) / 0.055, 0.65);
        if (starMetric <= 1.0) {
          blendRGBA(color, 255, 255, 255, 1.0);
        }

        // 次级温润小微光点
        const glintDist = Math.hypot(ex - 0.024, ey - 0.035);
        if (glintDist < 0.010) {
          blendRGBA(color, 255, 255, 255, 0.95);
        }
      } else if (dRhombus < 1.08) {
        // 边缘平滑抗锯齿
        const edgeA = clamp(1 - (dRhombus - 1.0) / 0.08, 0, 1);
        blendRGBA(color, 255, 77, 109, edgeA * 0.9);
      }
    }

    renderWarmStarDiamond(0.36, 0.58);
    renderWarmStarDiamond(0.64, 0.58);

    // 4. 软萌微醺腮红
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

    // 5. 可爱小猫嘴 (ω)
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

/**
 * 生成抗锯齿高清 PNG Buffer
 */
function generateAntialiasedPNG(size) {
  const rowSize = 1 + size * 4;
  const rawData = Buffer.alloc(rowSize * size);

  // 尺寸适配超采样级别 (16/32px 用 4x4, 48/128/256/512 用 3x3)
  const ss = size <= 32 ? 4 : (size <= 128 ? 3 : 2);
  const totalSamples = ss * ss;

  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter Type 0 (None)

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

  // PNG Signature
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type 6 (RGBA)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = createChunk('IHDR', ihdrData);

  // IDAT chunk
  const compressed = zlib.deflateSync(rawData);
  const idat = createChunk('IDAT', compressed);

  // IEND chunk
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

const iconsDir = path.resolve(projectRoot, 'src/icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

console.log('🚀 开始生成全尺寸温馨治愈猫耳标签图标 (16px ~ 512px)...');
[16, 32, 48, 128, 256, 512].forEach((size) => {
  const pngBuf = generateAntialiasedPNG(size);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, pngBuf);
  console.log(`✅ 已生成: ${outPath} (${size}x${size}, ${pngBuf.length} 字节)`);
});
console.log('✨ 治愈系家用图标全部生成完毕！');


