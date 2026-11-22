// 幻灯片的识别、排序和备注配对：纯函数，没有副作用，桌面端（slides.ts）和 iOS 预览的渲染器共用这一份。
// 约定见 slides.ts 顶部注释；Rust 侧（src-tauri/src/mcp/scene.rs）有同样的一份，改一边要改另一边。
import { boxOf, ext, isCommentLike, type El } from "./elements";

export type Slide = { frame: El; notes: El[]; notesText: string };

export const isFrameLike = (e: El) => !e.isDeleted && (e.type === "frame" || e.type === "magicframe");
/** 「备注」「Notes」整个词，后面没别的或者跟着分隔符：「Notes app redesign」「Notes & refs」不算 */
const NOTES_NAME = /^\s*(备注|notes)\s*($|[·:：\-—–(（|/])/i;
/** 固定页（slide 标记）永远是页，名字叫什么都不算备注 */
export const isNotesFrame = (e: El) => isFrameLike(e) && !ext(e)?.slide && (!!ext(e)?.notesFor || NOTES_NAME.test(e.name ?? ""));
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
