// Excalidesk 标志：用 Excalidraw 自己的 roughjs 画出「工具栏形状拼成的 E」。
// 竖笔是矩形，三横依次是矩形、菱形、椭圆，紫色斜线填充、黑色手绘描边，放在点阵白纸的 macOS 图标底板上。
// 方案来源：design/logo/e-shapes.png（Codex 生图），这里按它的比例重画成矢量。
//
//   node design/logo/make-logo.mjs     → excalidesk-mark.svg、excalidesk-icon.svg、icon-1024.png
//   npx tauri icon design/logo/icon-1024.png   → src-tauri/icons/*（会顺带生成 android/、ios/，本项目不用，删掉）
//   cp src-tauri/icons/128x128@2x.png public/icon.png   → 欢迎页图标
//
// 生成结果是确定的（固定 seed），改了参数重跑即可。需要 rsvg-convert（brew install librsvg）。
// roughjs 是 @excalidraw/excalidraw 带进来的依赖（node_modules 顶层就有），这个设计脚本不单独声明它。
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import rough from "roughjs";

const OUT = dirname(fileURLToPath(import.meta.url));

// ── 画法参数 ──────────────────────────────────────────
// 坐标用「画布单位」：1 单位 = 1024 图标上的 4 px，所以描边、斜线的手绘抖动和 Excalidraw 里看到的一样。
const U = 4;
const INK = "#1e1e1e";
const VIOLET = "#6965db";
const DOT = "#c9c7ea";
const style = {
  stroke: INK,
  strokeWidth: 2.6, // 描边（≈10 px）
  fill: VIOLET,
  fillStyle: "hachure",
  hachureAngle: -41, // Excalidraw 默认角度
  hachureGap: 7, // 斜线间距（≈28 px）：比生图稀一点，小尺寸下仍看得出是斜线；roughjs 4.6 遇到 6.4 这类小数会算不出斜线，用整数
  fillWeight: 1.4, // 斜线粗细（≈6 px）
  roughness: 1,
  bowing: 1,
};

// ── 字母几何（底板 206×206 单位，原点在底板左上角）────────
const dy = -2; // 字母整体上提一点，视觉居中
const shapes = [
  // 竖笔
  { kind: "rect", x: 48, y: 38 + dy, w: 30, h: 133, seed: 11 },
  // 上横：矩形
  { kind: "rect", x: 78, y: 38 + dy, w: 78, h: 31, seed: 23 },
  // 中横：菱形（左尖点贴着竖笔）
  { kind: "poly", pts: [[76, 103], [113, 87], [151, 103], [113, 119]].map(([x, y]) => [x, y + dy]), seed: 37 },
  // 下横：椭圆
  { kind: "ellipse", cx: 118, cy: 154 + dy, w: 80, h: 35, seed: 5 },
];

function markPaths() {
  const out = [];
  for (const s of shapes) {
    const g = rough.generator();
    const o = { ...style, seed: s.seed };
    const d =
      s.kind === "rect" ? g.rectangle(s.x, s.y, s.w, s.h, o)
      : s.kind === "ellipse" ? g.ellipse(s.cx, s.cy, s.w, s.h, o)
      : g.polygon(s.pts, o);
    for (const p of g.toPaths(d)) {
      // 斜线（fill 组）在下、描边在上，和 Excalidraw 渲染顺序一致
      out.push(
        `<path d="${round(p.d)}" fill="${p.fill || "none"}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
  }
  return out.join("\n");
}

const round = (d) => d.replace(/-?\d+\.\d+/g, (n) => (+n).toFixed(2));

// ── 底板：Apple 图标网格（1024 画布、824 底板、连续曲率圆角）────
const CANVAS = 1024;
const TILE = 824;
const PAD = (CANVAS - TILE) / 2;

function squircle(size, n = 4.2, steps = 720) {
  // 超椭圆 |x|^n + |y|^n = 1，近似 macOS 图标的连续曲率圆角
  const r = size / 2;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const c = Math.cos(t), s = Math.sin(t);
    pts.push([r + r * Math.sign(c) * Math.abs(c) ** (2 / n), r + r * Math.sign(s) * Math.abs(s) ** (2 / n)]);
  }
  return "M" + pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L") + "Z";
}

function dots() {
  // 点阵：间距 13.3 单位（≈53 px），只铺在底板内侧，避开圆角
  const step = 13.3, c = 103, out = [];
  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      const x = c + (i + 0.5) * step, y = c + (j + 0.5) * step;
      if (x < 22 || x > 184 || y < 22 || y > 184) continue;
      out.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="0.85"/>`);
    }
  }
  return `<g fill="${DOT}">${out.join("")}</g>`;
}

const mark = markPaths();

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
<defs>
  <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f3f3f6"/>
  </linearGradient>
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="10"/>
    <feOffset dy="10" result="b"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.28"/></feComponentTransfer>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<g transform="translate(${PAD} ${PAD})">
  <path d="${squircle(TILE)}" fill="url(#paper)" filter="url(#shadow)"/>
  <path d="${squircle(TILE)}" fill="none" stroke="#000" stroke-opacity="0.07" stroke-width="2"/>
  <g transform="scale(${U})">
${dots()}
${mark}
  </g>
</g>
</svg>
`;

// 单独的标志（透明底，裁到字母外框），给文档、网页用
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="42 30 122 148" width="${122 * U}" height="${148 * U}">
${mark}
</svg>
`;

writeFileSync(join(OUT, "excalidesk-icon.svg"), icon);
writeFileSync(join(OUT, "excalidesk-mark.svg"), markSvg);
execFileSync("rsvg-convert", ["-w", "1024", "-h", "1024", join(OUT, "excalidesk-icon.svg"), "-o", join(OUT, "icon-1024.png")]);
console.log("make-logo: excalidesk-icon.svg, excalidesk-mark.svg, icon-1024.png");
