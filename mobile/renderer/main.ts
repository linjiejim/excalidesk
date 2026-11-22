// iOS 预览的渲染器：跑在原生侧一个看不见的 WKWebView 里（excalidesk-renderer:// 自定义协议，字体也从这里取，完全离线）。
// 用和桌面端同一版本的 Excalidraw 把画布导出成 SVG 放进页面，原生侧再用 WKWebView.createPDF 拿到矢量 PDF，交给 PDFKit 显示。
// 原生侧通过 window.excalidesk 调这几个函数（callAsyncJavaScript）。
import { exportToSvg, restoreAppState, restoreElements } from "@excalidraw/excalidraw";
import { isCommentLike, type El } from "../../src/shell/elements";
import { isFrameLike, slidesOf } from "../../src/shell/slideOrder";

(window as any).EXCALIDRAW_ASSET_PATH = "/";

type Files = Record<string, { id: string; mimeType: string; dataURL: string }>;
type Loaded = { elements: El[]; files: Files; background: string };

/** PDF 页面最长边（pt）。再大 PDFKit 也能显示，但生成慢、内存高；超过就等比缩小，放大看仍是矢量 */
const MAX_PAGE = 12000;
const PADDING = 40;

let scene: Loaded | null = null;
const stage = () => document.getElementById("stage")!;

// ── 深色画布：和 Excalidraw 深色模式同一个滤镜（invert 93% + hue-rotate 180°），但直接换算颜色，PDF 里仍是矢量 ──
const probe = document.createElement("canvas").getContext("2d")!;
const darkCache = new Map<string, string>();
function darkColor(input: unknown): unknown {
  if (typeof input !== "string" || !input || input === "transparent") return input;
  const hit = darkCache.get(input);
  if (hit) return hit;
  probe.fillStyle = "#000";
  probe.fillStyle = input;
  const norm = String(probe.fillStyle);
  let r = 0, g = 0, b = 0, a = 1;
  if (norm.startsWith("#")) {
    r = parseInt(norm.slice(1, 3), 16) / 255;
    g = parseInt(norm.slice(3, 5), 16) / 255;
    b = parseInt(norm.slice(5, 7), 16) / 255;
  } else {
    const m = norm.match(/rgba?\(([^)]+)\)/);
    if (!m) return input;
    const p = m[1].split(",").map((s) => parseFloat(s));
    [r, g, b] = [p[0] / 255, p[1] / 255, p[2] / 255];
    a = p[3] ?? 1;
  }
  const inv = (v: number) => 0.93 - 0.86 * v;
  [r, g, b] = [inv(r), inv(g), inv(b)];
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  const out = [
    clamp(-0.574 * r + 1.43 * g + 0.144 * b),
    clamp(0.426 * r + 0.43 * g + 0.144 * b),
    clamp(0.426 * r + 1.43 * g - 0.856 * b),
  ];
  const res = a < 1 ? `rgba(${out.join(",")},${a})` : `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  darkCache.set(input, res);
  return res;
}

const toDark = (els: readonly El[]) =>
  els.map((e) => ({ ...e, strokeColor: darkColor(e.strokeColor), backgroundColor: darkColor(e.backgroundColor) }) as El);

// ── 给原生侧的接口 ──────────────────────────────────────

/** 读入画布，返回列表和搜索要用的摘要 */
function load(json: string) {
  const data = JSON.parse(json);
  if (!data || typeof data !== "object" || !Array.isArray(data.elements)) throw new Error("not_excalidraw");
  const restored = restoreElements(data.elements, null, { repairBindings: true }) as unknown as El[];
  // Agent 的批注便签不进预览（和桌面端导出 PDF 一致）
  const elements = restored.filter((e) => !e.isDeleted && !isCommentLike(e));
  const appState = restoreAppState(data.appState ?? {}, null);
  scene = { elements, files: (data.files ?? {}) as Files, background: appState.viewBackgroundColor || "#ffffff" };

  const slides = slidesOf(elements);
  const texts: string[] = [];
  for (const e of elements) {
    if (e.type === "text") texts.push(String(e.originalText ?? e.text ?? ""));
    else if (isFrameLike(e) && e.name) texts.push(String(e.name));
  }
  return {
    elementCount: elements.length,
    imageCount: elements.filter((e) => e.type === "image").length,
    background: scene.background,
    darkBackground: darkColor(scene.background),
    slides: slides.map((s, i) => ({ id: s.frame.id, name: String(s.frame.name ?? "").trim() || `${i + 1}`, notes: s.notesText })),
    text: texts.join("\n").slice(0, 20000),
  };
}

/** 把整张画布（frameId 为空）或某一页导出成 SVG 放进页面，返回页面尺寸（pt） */
async function render(opts: { frameId?: string | null; dark?: boolean }) {
  if (!scene) throw new Error("no_scene");
  const dark = !!opts.dark;
  const elements = dark ? toDark(scene.elements) : scene.elements;
  const frame = opts.frameId ? elements.find((e) => e.id === opts.frameId) : null;
  if (opts.frameId && !frame) throw new Error("frame_not_found");
  const background = (dark ? darkColor(scene.background) : scene.background) as string;

  const svg = await exportToSvg({
    elements: elements as any,
    files: scene.files as any,
    appState: {
      exportBackground: true,
      viewBackgroundColor: background,
      exportWithDarkMode: false,
      exportScale: 1,
      // 按页看时不画 frame 的边框（和桌面端放映一致）；整张画布保留边框，看得出结构
      frameRendering: { enabled: true, name: false, outline: !frame, clip: true },
    } as any,
    exportPadding: frame ? 0 : PADDING,
    exportingFrame: (frame ?? null) as any,
    renderEmbeddables: false,
  });

  let w = parseFloat(svg.getAttribute("width") || "0") || 1;
  let h = parseFloat(svg.getAttribute("height") || "0") || 1;
  const scale = Math.min(1, MAX_PAGE / Math.max(w, h));
  if (scale < 1) {
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
  }
  svg.style.display = "block";
  document.documentElement.style.background = background;
  document.body.style.background = background;
  stage().replaceChildren(svg);
  // 导出时内嵌的字体（base64 子集）要全部加载完：WebKit 在字体加载期间把文字画成透明，
  // 这时 createPDF 拿到的中文（Xiaolai 子集比较大，最慢）就是空的。所以逐个 load()，不只等 fonts.ready。
  // 不用 requestAnimationFrame：页面在屏幕外时 rAF 会停
  void stage().getBoundingClientRect();
  const faces = Array.from(document.fonts as unknown as Iterable<FontFace>);
  await Promise.all(faces.map((f) => (f.status === "loaded" ? null : f.load().catch(() => null))));
  await document.fonts.ready;
  await new Promise((r) => setTimeout(r, 30));
  return { width: w, height: h, background };
}

function clear() {
  stage().replaceChildren();
}

(window as any).excalidesk = { load, render, clear, ready: true };
