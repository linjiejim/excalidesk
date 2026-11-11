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

export type Order = { back?: readonly string[]; front?: readonly string[] };

/**
 * 调图层顺序（数组顺序就是从下到上）。每个元素连同它的标签一起挪。
 * 不在 frame 里的：放到整个场景的最下 / 最上（不会插进某个 frame 那一段中间）；
 * 在 frame 里的：放到同一 frame 里其他元素的最下 / 最上，不跑出 frame 那一段。
 * 同一边的多个元素按传入的先后排（后面的在上面）。挪过的元素 index 清空，交给 restoreElements 重新分配。
 */
export function reorder(els: readonly El[], order: Order): { elements: El[]; moved: Set<string> } {
  const byId = new Map(els.map((e) => [e.id, e]));
  const moved = new Set<string>();
  const unit = (id: string, side: "back" | "front") => {
    const e = byId.get(id);
    if (!e || moved.has(id)) return null;
    const ids = [id, ...els.filter((x) => x.containerId === id && !x.isDeleted).map((x) => x.id)];
    ids.forEach((x) => moved.add(x));
    return { side, frameId: e.frameId ?? null, ids };
  };
  const back = (order.back ?? []).map((id) => unit(id, "back")).filter((u) => !!u);
  const front = (order.front ?? []).map((id) => unit(id, "front")).filter((u) => !!u);
  if (!moved.size) return { elements: [...els], moved };
  const rest = els.filter((e) => !moved.has(e.id));
  const inFrame = (e: El, f: string) => !e.isDeleted && e.frameId === f;
  const put = (u: { side: "back" | "front"; frameId: string | null; ids: string[] }) => {
    const items = u.ids.map((id) => ({ ...byId.get(id)!, index: null }) as El);
    let at: number;
    const f = u.frameId;
    if (!f) at = u.side === "back" ? 0 : rest.length;
    else if (u.side === "back") {
      const i = rest.findIndex((e) => inFrame(e, f));
      at = i >= 0 ? i : rest.findIndex((e) => e.id === f) + 1;
    } else {
      let i = -1;
      rest.forEach((e, k) => inFrame(e, f) && (i = k));
      at = i >= 0 ? i + 1 : rest.findIndex((e) => e.id === f) + 1;
    }
    rest.splice(at, 0, ...items);
  };
  // 放到最下面的倒着插，才能保持传入的先后
  [...back].reverse().forEach(put);
  front.forEach(put);
  return { elements: rest, moved };
}

/**
 * 撤销调图层：只把这次挪过的元素放回原来的位置（排在原来紧挨着它下面、而且没挪过的那个元素之后），
 * 其他元素保持现在的顺序（用户之后自己调的不受影响）。
 */
export function unreorder<T extends { id: string }>(els: readonly T[], before: readonly string[], moved0: ReadonlySet<string>): T[] {
  // 那次新画的元素（撤销时变成删除记录）原地留着：删除记录必须保存下去，否则重新打开又会冒出来
  const existed = new Set(before);
  const moved = new Set([...moved0].filter((id) => existed.has(id)));
  const out = els.filter((e) => !moved.has(e.id));
  const byId = new Map(els.map((e) => [e.id, e]));
  let anchor: string | null = null;
  const groups: { anchor: string | null; items: T[] }[] = [];
  for (const id of before) {
    if (!moved.has(id)) {
      if (byId.has(id)) anchor = id;
      continue;
    }
    const e = byId.get(id);
    if (!e) continue;
    const g = groups[groups.length - 1];
    if (g && g.anchor === anchor) g.items.push(e);
    else groups.push({ anchor, items: [e] });
  }
  for (const g of groups) {
    const at = g.anchor ? out.findIndex((e) => e.id === g.anchor) + 1 : 0;
    out.splice(at, 0, ...g.items);
  }
  return out;
}
