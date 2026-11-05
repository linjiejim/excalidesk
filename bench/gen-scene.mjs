// 生成确定性的大图测试场景（.excalidraw），用法：node bench/gen-scene.mjs [out] [frames] [images]
// 默认 40 个 frame，每个 frame 内 35 条手绘 + 25 个图形 + 10 段文字 + 5 根箭头 ≈ 3040 个元素，外加 8 张截图大小的图片。
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";

const out = process.argv[2] ?? "public/scenes/large.excalidraw";
const FRAMES = Number(process.argv[3] ?? 40);
const IMAGES = Number(process.argv[4] ?? 8);

let s = 20261105;
const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const ri = (a, b) => Math.floor(a + rand() * (b - a));
const pick = (arr) => arr[ri(0, arr.length)];
let n = 0;
const id = (p) => `${p}-${(n++).toString(36)}`;

const COLORS = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];
const FILLS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"];
const WORDS = ["用户登录", "Sync queue", "缓存命中", "Render loop", "iCloud 冲突", "保存链路", "Thumbnail", "文件监听", "Excalidraw", "版本合并"];

const base = (type, x, y, w, h, extra = {}) => ({
  id: id(type), type, x, y, width: w, height: h, angle: 0,
  strokeColor: pick(COLORS), backgroundColor: "transparent", fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
  groupIds: [], frameId: null, roundness: null, seed: ri(1, 2 ** 31),
  version: 1, versionNonce: ri(1, 2 ** 31), isDeleted: false, boundElements: null,
  updated: 1762300000000, link: null, locked: false, ...extra,
});

// 噪声 PNG：不可压缩，体积接近真实截图
const crcTable = Array.from({ length: 256 }, (_, k) => {
  let c = k;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const noisePng = (w, h) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (rand() * 64 + 160) | 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
};

const elements = [];
const files = {};
const COLS = 8;
for (let f = 0; f < FRAMES; f++) {
  const fx = (f % COLS) * 1400, fy = Math.floor(f / COLS) * 1100;
  const frame = base("frame", fx, fy, 1200, 900, { name: `Frame ${f + 1}`, strokeColor: "#bbb" });
  elements.push(frame);
  const inFrame = { frameId: frame.id };

  for (let i = 0; i < 35; i++) {
    const pts = [[0, 0]];
    let px = 0, py = 0;
    const len = ri(30, 90);
    for (let k = 1; k < len; k++) {
      px += rand() * 8 - 2; py += rand() * 8 - 4;
      pts.push([+px.toFixed(2), +py.toFixed(2)]);
    }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const norm = pts.map(([x, y]) => [+(x - minX).toFixed(2), +(y - minY).toFixed(2)]);
    elements.push(base("freedraw", fx + ri(40, 1000), fy + ri(40, 760),
      Math.max(...xs) - minX, Math.max(...ys) - minY,
      { ...inFrame, points: norm, pressures: [], simulatePressure: true, lastCommittedPoint: null }));
  }
  for (let i = 0; i < 25; i++) {
    const type = pick(["rectangle", "ellipse", "diamond"]);
    elements.push(base(type, fx + ri(20, 1000), fy + ri(20, 760), ri(60, 200), ri(40, 140), {
      ...inFrame, backgroundColor: pick(FILLS), fillStyle: pick(["solid", "hachure", "cross-hatch"]),
      roundness: type === "rectangle" ? { type: 3 } : null,
    }));
  }
  for (let i = 0; i < 10; i++) {
    const text = `${pick(WORDS)} ${pick(WORDS)}`;
    const fontSize = pick([16, 20, 28]);
    elements.push(base("text", fx + ri(20, 900), fy + ri(20, 820), text.length * fontSize * 0.62, fontSize * 1.25, {
      ...inFrame, text, originalText: text, fontSize, fontFamily: 5, textAlign: "left",
      verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25,
    }));
  }
  for (let i = 0; i < 5; i++) {
    const dx = ri(-300, 300), dy = ri(-200, 200);
    elements.push(base("arrow", fx + ri(300, 900), fy + ri(250, 650), Math.abs(dx), Math.abs(dy), {
      ...inFrame, points: [[0, 0], [dx, dy]], lastCommittedPoint: null, startBinding: null,
      endBinding: null, startArrowhead: null, endArrowhead: "arrow", elbowed: false, roundness: { type: 2 },
    }));
  }
  if (f < IMAGES) {
    const fileId = `img${f}`.padEnd(40, "0");
    const png = noisePng(400, 300);
    files[fileId] = { id: fileId, mimeType: "image/png", dataURL: `data:image/png;base64,${png.toString("base64")}`, created: 1762300000000 };
    elements.push(base("image", fx + 700, fy + 520, 400, 300, {
      ...inFrame, fileId, status: "saved", scale: [1, 1], crop: null, strokeColor: "transparent",
    }));
  }
}

const doc = {
  type: "excalidraw", version: 2, source: "p0-bench",
  elements, appState: { viewBackgroundColor: "#ffffff", gridSize: 20 }, files,
};
mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify(doc);
writeFileSync(out, json);
const byType = elements.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});
console.log(out, `${(json.length / 1e6).toFixed(2)} MB`, elements.length, "elements", JSON.stringify(byType));
