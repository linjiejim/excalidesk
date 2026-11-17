// 演示文稿的约定（docs/specs/20261117-presentation-mode.md）：
//   一页 = 一个 frame（备注 frame 除外）；先行后列地放映。
//   customData.excalidesk.slide = true      固定尺寸页（1920×1080）：Agent 往里加东西不撑大，超出的报告出来
//   customData.excalidesk.notesFor = 页 id  演讲者备注 frame，放在页下方；名字以「备注 / Notes」开头的手画 frame 也算
// 排序和配对在 Rust 侧（src-tauri/src/mcp/scene.rs）有同样的一份，改一边要改另一边。
import { CaptureUpdateAction, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { boxOf, ext, isCommentLike, randomId, unionBox, type Box, type El } from "./elements";
import { t } from "./i18n";
import type { DocSession } from "./session";
import { toast } from "./store";

export const SLIDE_W = 1920, SLIDE_H = 1080, SLIDE_GAP = 160, NOTES_GAP = 80, NOTES_H = 480;
const NOTES_PAD = 40;

export type Slide = { frame: El; notes: El[]; notesText: string };

const isFrameLike = (e: El) => !e.isDeleted && (e.type === "frame" || e.type === "magicframe");
const NOTES_NAME = /^\s*(备注|notes)/i;
export const isNotesFrame = (e: El) => isFrameLike(e) && (!!ext(e)?.notesFor || NOTES_NAME.test(e.name ?? ""));
export const isFixedSlide = (e: El) => isFrameLike(e) && !!ext(e)?.slide;

/** 先行后列：按顶边排，垂直中线落在当前行上下范围内的归进这一行，行内从左到右 */
export function orderSlides(frames: readonly El[]): El[] {
  const sorted = [...frames].sort((a, b) => boxOf(a).y - boxOf(b).y || boxOf(a).x - boxOf(b).x);
  const rows: { top: number; bottom: number; items: El[] }[] = [];
  for (const f of sorted) {
    const b = boxOf(f);
    const row = rows[rows.length - 1];
    const cy = b.y + b.h / 2;
    if (row && cy >= row.top && cy <= row.bottom) {
      row.items.push(f);
      row.bottom = Math.max(row.bottom, b.y + b.h);
    } else rows.push({ top: b.y, bottom: b.y + b.h, items: [f] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => boxOf(a).x - boxOf(b).x || boxOf(a).y - boxOf(b).y));
}

/** 备注归哪一页：正上方最近的一页优先（复制页 + 备注时 notesFor 还指着原来那页）；正上方没有页才用 notesFor */
function ownerOf(n: El, slides: readonly El[]): El | undefined {
  const nb = boxOf(n);
  const cx = nb.x + nb.w / 2;
  let best: El | undefined, gap = Infinity;
  for (const s of slides) {
    const b = boxOf(s);
    if (cx < b.x || cx > b.x + b.w || nb.y < b.y + b.h / 2) continue;
    const g = Math.abs(nb.y - (b.y + b.h));
    if (g < gap) [best, gap] = [s, g];
  }
  if (best) return best;
  const id = ext(n)?.notesFor;
  return id ? slides.find((s) => s.id === id) : undefined;
}

/** 备注 frame 里的文字（含形状里的标签），按 y、x 排，用空行连起来 */
function notesText(notes: readonly El[], live: readonly El[]) {
  const byId = new Map(live.map((e) => [e.id, e]));
  const inFrame = (e: El, f: string) => e.frameId === f || (!!e.containerId && byId.get(e.containerId)?.frameId === f);
  return notes
    .map((n) =>
      live
        .filter((e) => e.type === "text" && !isCommentLike(e) && inFrame(e, n.id))
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((e) => String(e.originalText ?? e.text ?? "").trim())
        .filter(Boolean)
        .join("\n\n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

/** 按放映顺序的页，带各自的备注 */
export function slidesOf(elements: readonly El[]): Slide[] {
  const live = elements.filter((e) => !e.isDeleted);
  const frames = live.filter(isFrameLike);
  const slides = orderSlides(frames.filter((f) => !isNotesFrame(f)));
  const notes = new Map(slides.map((s) => [s.id, [] as El[]]));
  for (const n of frames.filter(isNotesFrame)) {
    const o = ownerOf(n, slides);
    if (o) notes.get(o.id)!.push(n);
  }
  return slides.map((frame) => {
    const ns = notes.get(frame.id)!.sort((a, b) => a.y - b.y);
    return { frame, notes: ns, notesText: notesText(ns, live) };
  });
}

/** 新页放哪：最后一页右边（跳过挡在那一带的其他内容）；还没有页就放在现有内容右边；空画布放原点 */
export function nextSlideBox(elements: readonly El[], w = SLIDE_W, h = SLIDE_H): Box {
  const live = elements.filter((e) => !e.isDeleted && !isCommentLike(e));
  const slides = slidesOf(live);
  if (!slides.length) {
    const all = unionBox(live);
    return all ? { x: all.x + all.w + SLIDE_GAP, y: all.y, w, h } : { x: 0, y: 0, w, h };
  }
  const last = boxOf(slides[slides.length - 1].frame);
  const band = { top: last.y, bottom: last.y + Math.max(last.h, h) + NOTES_GAP + NOTES_H };
  let x = last.x + last.w;
  for (const e of live) {
    const b = boxOf(e);
    if (b.x + b.w > x && b.x >= last.x && b.y < band.bottom && b.y + b.h > band.top) x = b.x + b.w;
  }
  return { x: x + SLIDE_GAP, y: last.y, w, h };
}

// ── 造元素 ─────────────────────────────────────────────

export function buildFrame(box: Box, name: string | null, data?: Record<string, unknown>): El {
  const [r] = convertToExcalidrawElements([{ type: "rectangle", id: randomId(), x: box.x, y: box.y, width: box.w, height: box.h } as any], { regenerateIds: false }) as unknown as El[];
  const f: El = { ...r, type: "frame", name, roundness: null, backgroundColor: "transparent", strokeColor: "#bbb", boundElements: null };
  return data ? { ...f, customData: { excalidesk: data } } : f;
}

/** 页下方的备注 frame + 一段会自动换行的文字（透明矩形里的标签）。文字长就把 frame 撑高 */
export function buildNotes(slide: El, text: string, name = t("slides.notesName")): { frame: El; holder: El; elements: El[] } {
  const fb = { x: slide.x, y: slide.y + slide.height + NOTES_GAP, w: slide.width, h: NOTES_H };
  const frame = buildFrame(fb, name, { notesFor: slide.id });
  const holderId = randomId();
  const made = convertToExcalidrawElements(
    [{
      type: "rectangle", id: holderId, x: fb.x + NOTES_PAD, y: fb.y + NOTES_PAD, width: fb.w - NOTES_PAD * 2, height: 80,
      strokeColor: "transparent", backgroundColor: "transparent", roughness: 0,
      label: { text, fontSize: 28, fontFamily: 2, textAlign: "left", verticalAlign: "top", strokeColor: "#1e1e1e" },
    } as any],
    { regenerateIds: false },
  ) as unknown as El[];
  const inner = made.map((e) => ({ ...e, frameId: frame.id }));
  const box = unionBox(inner)!;
  if (box.y + box.h + NOTES_PAD > fb.y + fb.h) frame.height = box.y + box.h + NOTES_PAD - fb.y;
  return { frame, holder: inner.find((e) => e.id === holderId)!, elements: [frame, ...inner] };
}

// ── 用户的动作 ─────────────────────────────────────────

/** 选中的页（选中了页里的东西也算）→ 视口中心所在的页 */
export function pickSlide(api: any, slides: readonly Slide[]): number {
  const st = api.getAppState();
  const byId = new Map((api.getSceneElements() as El[]).map((e) => [e.id, e]));
  for (const id of Object.keys(st.selectedElementIds ?? {})) {
    if (!st.selectedElementIds[id]) continue;
    const e = byId.get(id);
    const fid = e && (isFrameLike(e) ? e.id : (e.frameId ?? (e.containerId ? byId.get(e.containerId)?.frameId : null)));
    const i = slides.findIndex((s) => s.frame.id === fid || s.notes.some((n) => n.id === fid));
    if (i >= 0) return i;
  }
  const z = st.zoom.value;
  const cx = st.width / 2 / z - st.scrollX, cy = st.height / 2 / z - st.scrollY;
  return slides.findIndex((s) => {
    const b = boxOf(s.frame);
    return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
  });
}

const focusOn = (api: any, els: El[], select: El) => {
  api.updateScene({ appState: { selectedElementIds: { [select.id]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
  api.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.8, animate: true });
};

/** 新建一页：1920×1080，接在最后一页右边，选中并对准它 */
export function newSlide(s: DocSession | null | undefined) {
  const api = s?.api;
  if (!api) return;
  const els = api.getSceneElementsIncludingDeleted() as El[];
  const n = slidesOf(els).length + 1;
  const f = buildFrame(nextSlideBox(els), t("slides.name", { n }), { slide: true });
  api.updateScene({ elements: [...els, f], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  focusOn(api, [f], f);
}

/** 给选中的页（或视口中心那页）加演讲者备注；已经有了就跳过去 */
export function addNotes(s: DocSession | null | undefined) {
  const api = s?.api;
  if (!api) return;
  const els = api.getSceneElementsIncludingDeleted() as El[];
  const slides = slidesOf(els);
  const i = pickSlide(api, slides);
  if (i < 0) {
    toast(t(slides.length ? "slides.pickFirst" : "present.none"));
    return;
  }
  const sl = slides[i];
  if (sl.notes.length) {
    const inside = els.filter((e) => !e.isDeleted && e.frameId === sl.notes[0].id && e.type !== "text");
    focusOn(api, [sl.frame, ...sl.notes], inside[0] ?? sl.notes[0]);
    return;
  }
  const made = buildNotes(sl.frame, t("slides.notesPlaceholder"));
  api.updateScene({ elements: [...els, ...made.elements], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  focusOn(api, [sl.frame, made.frame], made.holder);
}
