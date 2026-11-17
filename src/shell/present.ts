// 放映（docs/specs/20261117-presentation-mode.md）：活画布 + 自己算的镜头 + 遮罩。
// 镜头不用 scrollToContent：它把缩放向下取整到 0.1 一档，页铺不满屏幕。
// 遮罩是一个跟当前页重合的透明框，box-shadow 把框外涂黑；翻页补间时框在两页之间插值，内容从框里推过去。
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { sessions } from "./actions";
import { boxOf, type Box, type El } from "./elements";
import { t } from "./i18n";
import { inTauri } from "./ipc";
import type { DocSession } from "./session";
import { pickSlide, slidesOf, type Slide } from "./slides";
import { getState, setState, subscribe, toast } from "./store";

type Ctl = {
  s: DocSession;
  api: any;
  path: string;
  saved: Record<string, unknown>;
  tool: { type: string; customType?: string | null };
  wasFullscreen: boolean;
  slideId: string;
  index: number;
  /** 遮罩框（场景坐标）：当前页；补间时是两页之间的插值 */
  box: Box;
  raf: number;
  tweening: boolean;
  /** 上次对准时的画布尺寸 + 页的位置：变了就重新对准 */
  fitKey: string;
  off: (() => void)[];
};

let ctl: Ctl | null = null;
export const isPresenting = () => !!ctl;

const DURATION = 380;
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpBox = (a: Box, b: Box, k: number): Box => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) });

/** 页正好铺满一个方向、居中 */
function camFor(st: any, b: Box) {
  const zoom = Math.min(st.width / b.w, st.height / b.h);
  return { zoom: { value: zoom }, scrollX: st.width / 2 / zoom - (b.x + b.w / 2), scrollY: st.height / 2 / zoom - (b.y + b.h / 2) };
}

const keyOf = (st: any, b: Box) => `${st.width}x${st.height}:${b.x},${b.y},${b.w},${b.h}`;

type Cam = { scrollX: number; scrollY: number; zoom: number };

/**
 * 遮罩跟着页在屏幕上的位置走。cam 是刚设下去的镜头：updateScene 之后 getAppState 要等 React 提交才变，
 * 用它算会比画面慢一帧。没传 cam（用户拖动之后、界面重绘）才读当前状态；补间中不读。
 */
export function paintMask(cam?: Cam) {
  const c = ctl;
  const el = document.querySelector<HTMLElement>(".present-mask");
  if (!c || !el || (!cam && c.tweening)) return;
  const st = c.api.getAppState();
  const { scrollX, scrollY, zoom: z } = cam ?? { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value };
  el.style.left = `${(c.box.x + scrollX) * z + st.offsetLeft}px`;
  el.style.top = `${(c.box.y + scrollY) * z + st.offsetTop}px`;
  el.style.width = `${c.box.w * z}px`;
  el.style.height = `${c.box.h * z}px`;
}

/** 把镜头对准 c.box，并同步遮罩 */
function aim(c: Ctl) {
  const cam = camFor(c.api.getAppState(), c.box);
  c.api.updateScene({ appState: cam, captureUpdate: CaptureUpdateAction.NEVER });
  paintMask({ scrollX: cam.scrollX, scrollY: cam.scrollY, zoom: cam.zoom.value });
}

function fit() {
  const c = ctl;
  if (!c) return;
  const f = (c.api.getSceneElements() as El[]).find((e) => e.id === c.slideId);
  if (f) c.box = boxOf(f);
  c.fitKey = keyOf(c.api.getAppState(), c.box);
  aim(c);
}

function show(slides: Slide[], j: number, animate: boolean) {
  const c = ctl;
  if (!c) return;
  const sl = slides[j];
  const from = c.box, to = boxOf(sl.frame);
  c.slideId = sl.frame.id;
  c.index = j;
  cancelAnimationFrame(c.raf);
  c.tweening = false;
  setState((s) => ({ presenting: s.presenting && { ...s.presenting, index: j, total: slides.length, notesText: sl.notesText } }));
  if (!animate) {
    c.box = to;
    fit();
    return;
  }
  c.tweening = true;
  const t0 = performance.now();
  const step = (now: number) => {
    if (ctl !== c) return;
    const k = ease(Math.min(1, (now - t0) / DURATION));
    c.box = lerpBox(from, to, k);
    aim(c);
    if (k < 1) c.raf = requestAnimationFrame(step);
    else {
      c.tweening = false;
      fit();
    }
  };
  c.raf = requestAnimationFrame(step);
}

type Go = "next" | "prev" | "first" | "last";
function go(where: Go) {
  const c = ctl;
  if (!c) return;
  // 每次都重新算：放映中 Agent 可能加了、删了、挪了页
  const slides = slidesOf(c.api.getSceneElements());
  if (!slides.length) return stopPresentation();
  let i = slides.findIndex((s) => s.frame.id === c.slideId);
  if (i < 0) i = Math.min(c.index, slides.length - 1);
  const j = where === "first" ? 0 : where === "last" ? slides.length - 1 : Math.max(0, Math.min(slides.length - 1, i + (where === "next" ? 1 : -1)));
  // 相邻页推过去；跳很远直接切
  show(slides, j, Math.abs(j - i) === 1);
}

/**
 * 激光笔：Excalidraw 0.18 的只读模式下，按下指针一律先当成拖动画布，激光笔根本画不出来。
 * 所以开激光笔时临时退出只读模式：界面层照样藏着，按键、粘贴、右键都被拦下，激光笔工具下双击也不会建文字。
 */
function toggleLaser() {
  const c = ctl;
  if (!c) return;
  const on = c.api.getAppState().activeTool.type !== "laser";
  if (on) {
    c.api.updateScene({ appState: { viewModeEnabled: false }, captureUpdate: CaptureUpdateAction.NEVER });
    c.api.setActiveTool({ type: "laser" });
  } else {
    c.api.setActiveTool({ type: "selection" });
    c.api.updateScene({ appState: { viewModeEnabled: true, selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
  }
  document.documentElement.toggleAttribute("data-laser", on);
}

const NEXT = new Set(["ArrowRight", "ArrowDown", "PageDown", "Enter"]);
const PREV = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace"]);

function onKey(e: KeyboardEvent) {
  if (!ctl || e.isComposing) return;
  // Excalidraw 一个键都收不到（⌘Z 撤销、⌘D 复制都不行）。⌘ / ⌃ 组合键不 preventDefault：菜单快捷键（再按 ⌥⌘P、⌘Q）还要能用
  e.stopPropagation();
  if (e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  if (e.repeat && !NEXT.has(e.key) && !PREV.has(e.key)) return;
  if (e.key === " ") go(e.shiftKey ? "prev" : "next");
  else if (NEXT.has(e.key)) go("next");
  else if (PREV.has(e.key)) go("prev");
  else if (e.key === "Home") go("first");
  else if (e.key === "End") go("last");
  else if (e.key === "Escape") stopPresentation();
  else if (e.code === "KeyK") toggleLaser();
  else if (e.code === "KeyN") setState((s) => ({ presenting: s.presenting && { ...s.presenting, notes: !s.presenting.notes } }));
}

/** 滚轮、触控板缩放（不挪镜头）；粘贴、剪切、拖放、右键（不改图） */
const BLOCKED = ["wheel", "gesturestart", "gesturechange", "gestureend", "paste", "cut", "dragover", "drop", "contextmenu"];
const block = (e: Event) => {
  if (!ctl) return;
  e.preventDefault();
  e.stopPropagation();
};

async function setFullscreen(on: boolean) {
  if (!inTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setFullscreen(on).catch(() => {});
}

/** 从当前页（选中的页 → 视口中心那页 → 第一页）或第一页开始放映 */
export function startPresentation(fromStart = false) {
  if (ctl) return;
  const { active } = getState();
  const s = active ? sessions.get(active) : undefined;
  const api = s?.api;
  if (!s || !api) return;
  const slides = slidesOf(api.getSceneElements());
  if (!slides.length) {
    toast(t("present.none"));
    return;
  }
  const picked = fromStart ? 0 : pickSlide(api, slides);
  const i = picked < 0 ? 0 : picked;
  const st = api.getAppState();
  const c: Ctl = {
    s, api, path: s.path,
    saved: {
      viewModeEnabled: st.viewModeEnabled, zenModeEnabled: st.zenModeEnabled, frameRendering: st.frameRendering,
      selectedElementIds: st.selectedElementIds, selectedGroupIds: st.selectedGroupIds,
      scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom,
    },
    tool: st.activeTool,
    wasFullscreen: getState().fullscreen,
    slideId: slides[i].frame.id, index: i, box: boxOf(slides[i].frame),
    raf: 0, tweening: false, fitKey: "", off: [],
  };
  ctl = c;
  s.viewportOverride = { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value };
  api.updateScene({
    appState: {
      viewModeEnabled: true, zenModeEnabled: true,
      frameRendering: { enabled: true, clip: true, name: false, outline: false },
      selectedElementIds: {}, selectedGroupIds: {}, openMenu: null, openPopup: null, openSidebar: null, openDialog: null,
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  setState({ presenting: { path: s.path, index: i, total: slides.length, notes: false, notesText: slides[i].notesText }, commentDraft: null, history: false });

  window.addEventListener("keydown", onKey, true);
  for (const ev of BLOCKED) window.addEventListener(ev, block, { capture: true, passive: false });
  // 外壳隐藏、进出全屏都会改画布尺寸：让 Excalidraw 重新量一下，onChange 里发现尺寸变了就重新对准
  const refresh = () => requestAnimationFrame(() => ctl === c && c.api.refresh?.());
  window.addEventListener("resize", refresh);
  c.off.push(
    () => {
      window.removeEventListener("keydown", onKey, true);
      for (const ev of BLOCKED) window.removeEventListener(ev, block, true);
      window.removeEventListener("resize", refresh);
    },
    api.onScrollChange((scrollX: number, scrollY: number, zoom: { value: number }) => !c.tweening && paintMask({ scrollX, scrollY, zoom: zoom.value })),
    api.onChange((els: readonly El[], st2: any) => {
      if (ctl !== c || c.tweening) return;
      const f = els.find((e) => e.id === c.slideId && !e.isDeleted);
      if (keyOf(st2, f ? boxOf(f) : c.box) !== c.fitKey) requestAnimationFrame(fit);
    }),
    // 切走、关掉这张图，或者画布重新挂载了：退出放映
    subscribe(() => {
      const g = getState();
      if (ctl === c && (g.active !== c.path || sessions.get(c.path) !== c.s || c.s.api !== c.api)) stopPresentation();
    }),
  );
  // 启动时就是全屏的窗口，store 里的 fullscreen 还没被 onResized 更新过：直接问窗口
  void (async () => {
    if (!inTauri) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    c.wasFullscreen = await getCurrentWindow().isFullscreen().catch(() => c.wasFullscreen);
    if (!c.wasFullscreen && ctl === c) await setFullscreen(true);
  })();
  refresh();
  requestAnimationFrame(() => show(slides, i, false));
}

export function stopPresentation() {
  const c = ctl;
  if (!c) return;
  ctl = null;
  cancelAnimationFrame(c.raf);
  c.off.forEach((f) => f());
  document.documentElement.removeAttribute("data-laser");
  if (c.s.api === c.api) {
    // 先退出只读模式，再换回原来的工具（只读模式下有些工具换不进去）。
    // 只读模式一切换，Excalidraw 会在 componentDidUpdate 里清空选择，所以选择晚一帧再放回去
    const { selectedElementIds, selectedGroupIds, ...rest } = c.saved;
    c.api.updateScene({ appState: rest, captureUpdate: CaptureUpdateAction.NEVER });
    const tool = c.tool;
    c.api.setActiveTool(tool.type === "custom" ? { type: "custom", customType: tool.customType } : { type: tool.type });
    requestAnimationFrame(() => {
      if (c.s.api === c.api) c.api.updateScene({ appState: { selectedElementIds, selectedGroupIds }, captureUpdate: CaptureUpdateAction.NEVER });
    });
  }
  // 放映中被切走、关掉时已经按放映前的镜头记过视口；这里再记一次，然后恢复正常记录
  c.s.saveViewport();
  c.s.viewportOverride = null;
  setState({ presenting: null });
  if (!c.wasFullscreen) void setFullscreen(false);
}

export function togglePresentation(fromStart = false) {
  if (ctl) stopPresentation();
  else startPresentation(fromStart);
}

if (import.meta.env.DEV) (window as any).__present = { start: startPresentation, stop: stopPresentation, go, state: () => ctl && { index: ctl.index, slideId: ctl.slideId, box: ctl.box } };
