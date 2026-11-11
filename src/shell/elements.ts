// 元素层面的小工具：批注识别、作者标记、标签重排、箭头走线、版本号。Agent 操作和批注都用它。
// 约定（和 Rust 侧 mcp/scene.rs 一致）：
//   customData.excalidesk.by          最后写它的 Agent
//   customData.excalidesk.comment     批注便签本身 {targets, status, author, reply?, resolvedBy?}
//   customData.excalidesk.commentOf   批注的附属元素（便签里的文字、指向目标的箭头）
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

export type El = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  containerId?: string | null;
  frameId?: string | null;
  boundElements?: { id: string; type: string }[] | null;
  customData?: Record<string, any>;
  [k: string]: any;
};

export const REPLY_SEP = "\n——\n";

export const ext = (e: El): Record<string, any> | undefined => e.customData?.excalidesk;
export const isComment = (e: El) => !!ext(e)?.comment;
export const commentOf = (e: El): string | undefined => ext(e)?.commentOf;
/** 批注便签或它的附属元素 */
export const isCommentLike = (e: El) => isComment(e) || !!commentOf(e);
export const isOpenComment = (e: El) => !e.isDeleted && isComment(e) && ext(e)!.comment.status !== "resolved";

export const nonce = () => (Math.random() * 2 ** 31) | 0;
export const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** 改过的元素：版本号抬高、换 nonce，合并时才会胜出 */
export const bump = <T extends El>(e: T, patch: Partial<El> = {}): T => ({ ...e, ...patch, version: e.version + 1, versionNonce: nonce(), updated: Date.now() }) as T;

export function stamp(e: El, by: string): El {
  return { ...e, customData: { ...e.customData, excalidesk: { ...e.customData?.excalidesk, by, at: Date.now() } } };
}

export type Box = { x: number; y: number; w: number; h: number };
export const boxOf = (e: El): Box => ({ x: Math.min(e.x, e.x + e.width), y: Math.min(e.y, e.y + e.height), w: Math.abs(e.width), h: Math.abs(e.height) });

export function unionBox(els: readonly El[]): Box | null {
  if (!els.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    const b = boxOf(e);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 线和画框的边界：线段从中心朝 to 方向射出，和框（椭圆、菱形按外接框近似）的交点，再往外留 gap */
function borderPoint(b: Box, to: { x: number; y: number }, gap: number) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const dx = to.x - cx, dy = to.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const tx = dx ? b.w / 2 / Math.abs(dx) : Infinity;
  const ty = dy ? b.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  const len = Math.hypot(dx, dy);
  return { x: cx + dx * t + (dx / len) * gap, y: cy + dy * t + (dy / len) * gap };
}

/** 两个框之间的直线箭头：返回 x、y 和 points */
export function route(a: Box, b: Box, gap = 6) {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const p1 = borderPoint(a, cb, gap), p2 = borderPoint(b, ca, gap);
  return { x: p1.x, y: p1.y, points: [[0, 0], [p2.x - p1.x, p2.y - p1.y]] as [number, number][] };
}

/**
 * 给容器（矩形、椭圆、菱形、箭头）配上或换掉标签文字：借 Excalidraw 的转换把文字量好、摆好、必要时撑高容器，
 * 再把结果写回原来的元素（保留 id）。
 */
export function layoutLabel(container: El, text: El | null, value: string, props: Record<string, any> = {}): { container: El; text: El | null } {
  const bound = container.boundElements ?? [];
  // 空字符串 = 去掉标签（Excalidraw 的转换遇到空标签不产出文字元素）
  if (!value) return { container: bump(container, { boundElements: bound.filter((b) => b.type !== "text") }), text: text ? bump(text, { isDeleted: true }) : null };
  const sk: any = {
    type: container.type,
    id: container.id,
    x: container.x,
    y: container.y,
    width: container.width,
    height: container.height,
    label: {
      text: value,
      fontSize: props.fontSize ?? text?.fontSize ?? 20,
      fontFamily: props.fontFamily ?? text?.fontFamily,
      textAlign: props.textAlign ?? text?.textAlign ?? "center",
      verticalAlign: props.verticalAlign ?? text?.verticalAlign ?? "middle",
      strokeColor: props.strokeColor ?? text?.strokeColor,
    },
  };
  if (container.points) sk.points = container.points;
  const out = convertToExcalidrawElements([sk], { regenerateIds: false }) as unknown as El[];
  const c2 = out.find((e) => e.id === container.id)!;
  const t2 = out.find((e) => e.type === "text")!;
  const geometry = { x: t2.x, y: t2.y, width: t2.width, height: t2.height, text: t2.text, originalText: t2.originalText, lineHeight: t2.lineHeight, fontSize: t2.fontSize, fontFamily: t2.fontFamily, textAlign: t2.textAlign, verticalAlign: t2.verticalAlign };
  const nextText: El = text
    ? bump(text, geometry)
    : { ...t2, containerId: container.id, frameId: container.frameId ?? null, groupIds: container.groupIds ?? [] };
  const nextContainer = bump(container, {
    height: container.points ? container.height : Math.max(container.height, c2.height),
    boundElements: bound.some((b) => b.id === nextText.id) ? bound : [...bound.filter((b) => b.type !== "text"), { id: nextText.id, type: "text" }],
  });
  return { container: nextContainer, text: nextText };
}

/** 独立文字元素换内容：同样借转换量尺寸 */
export function relayoutText(text: El, value: string, fontSize?: number): El {
  const [t2] = convertToExcalidrawElements(
    [{ type: "text", x: text.x, y: text.y, text: value, fontSize: fontSize ?? text.fontSize, fontFamily: text.fontFamily, textAlign: text.textAlign } as any],
    { regenerateIds: true },
  ) as unknown as El[];
  return bump(text, { text: t2.text, originalText: t2.originalText, width: t2.width, height: t2.height, fontSize: t2.fontSize, lineHeight: t2.lineHeight });
}

export const boundTextOf = (container: El, byId: Map<string, El>) => {
  const ref = container.boundElements?.find((b) => b.type === "text");
  const t = ref ? byId.get(ref.id) : undefined;
  return t && !t.isDeleted ? t : null;
};
