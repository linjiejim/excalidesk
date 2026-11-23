// 转换形状（docs/specs/20261123-convert-shapes.md）：文本 ↔ 矩形 / 菱形 / 椭圆，矩形 / 菱形 / 椭圆互转。
// 这里只算：给定场景和选中的元素，算出要改的元素。写进画布、撤销、浮层在 ConvertMenu.tsx。
// 升级到自带转换浮层的 Excalidraw 时，形状互转交给上游，这里只留文本 ↔ 形状（见 spec「和上游的接缝」）。
import { ROUNDNESS, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { bump, isCommentLike, layoutLabel, nonce, randomId, relayoutText, type El } from "./elements";

export type Target = "rectangle" | "diamond" | "ellipse" | "text";
/** 浮层里的顺序，也是 Tab 循环的顺序：前三个和上游一致，文本是 Excalidesk 加的 */
export const TARGETS: readonly Target[] = ["rectangle", "diamond", "ellipse", "text"];
/** ⇧ + 工具字母（按物理键位） */
export const TARGET_KEYS: Record<string, Target> = { KeyR: "rectangle", KeyD: "diamond", KeyO: "ellipse", KeyT: "text" };

const SHAPES = new Set(["rectangle", "diamond", "ellipse"]);
const PAD = 5; // Excalidraw 的 BOUND_TEXT_PADDING

/** 一个可转换的单元：独立文本，或者矩形 / 菱形 / 椭圆（连同它里面的文字） */
export type Unit = { el: El; text: El | null };

const kindOf = (u: Unit): Target => (u.el.type === "text" ? "text" : (u.el.type as Target));

/** 新建容器用的样式（文本 → 形状）：描边颜色和透明度跟文字走，其余用当前画笔的样式，和 Excalidraw 的「将文本包围在容器中」一样 */
export type Style = { backgroundColor: string; fillStyle: string; strokeWidth: number; strokeStyle: string; roughness: number; roundness: "round" | "sharp" };

export function styleOf(appState: Record<string, any>): Style {
  return {
    backgroundColor: appState.currentItemBackgroundColor ?? "transparent",
    fillStyle: appState.currentItemFillStyle ?? "solid",
    strokeWidth: appState.currentItemStrokeWidth ?? 2,
    strokeStyle: appState.currentItemStrokeStyle ?? "solid",
    roughness: appState.currentItemRoughness ?? 1,
    roundness: appState.currentItemRoundness ?? "round",
  };
}

/** 选区里能转换的单元。选中了形状里的文字也算那个形状；锁住的、批注便签和其他类型跳过 */
export function unitsOf(elements: readonly El[], selected: Record<string, boolean | undefined>): Unit[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const live = (id: string | null | undefined) => {
    const e = id ? byId.get(id) : undefined;
    return e && !e.isDeleted ? e : undefined;
  };
  const out: Unit[] = [];
  const seen = new Set<string>();
  for (const [id, on] of Object.entries(selected)) {
    if (!on) continue;
    let e = live(id);
    if (!e) continue;
    if (e.type === "text" && e.containerId) e = live(e.containerId);
    if (!e || seen.has(e.id) || e.locked || isCommentLike(e)) continue;
    if (e.type === "text") {
      seen.add(e.id);
      out.push({ el: e, text: null });
    } else if (SHAPES.has(e.type)) {
      seen.add(e.id);
      const ref = e.boundElements?.find((b) => b.type === "text");
      const t = live(ref?.id);
      out.push({ el: e, text: t && t.containerId === e.id ? t : null });
    }
  }
  return out;
}

/** 这个单元转成 target 会不会变：没有文字的形状不能转成文本 */
export const changes = (u: Unit, target: Target) => kindOf(u) !== target && (target !== "text" || !!u.text);

/** 选区的当前类型：都一样时是那个类型，否则 null */
export function currentOf(units: readonly Unit[]): Target | null {
  const kinds = new Set(units.map(kindOf));
  return kinds.size === 1 ? [...kinds][0] : null;
}

/** Tab 循环的顺序：当前类型（回到原样）+ 至少有一个单元会变的类型 */
export function cycleOf(units: readonly Unit[]): Target[] {
  const cur = currentOf(units);
  return TARGETS.filter((t) => t === cur || units.some((u) => changes(u, t)));
}

/** Excalidraw 的 computeContainerDimensionForBoundText */
function containerDim(d: number, type: string) {
  const v = Math.ceil(d), p = PAD * 2;
  if (type === "ellipse") return Math.round(((v + p) / Math.SQRT2) * 2);
  if (type === "diamond") return 2 * (v + p);
  return v + p;
}

const roundnessFor = (type: string) => ({ type: type === "rectangle" ? ROUNDNESS.ADAPTIVE_RADIUS : ROUNDNESS.PROPORTIONAL_RADIUS });

type Result = {
  /** 改过的和新建的元素 */
  changed: El[];
  /** 新建的元素放在谁的下面（id → 紧挨着它上面那个元素的 id） */
  below: Map<string, string>;
  /** 转换后应该选中的元素 */
  select: string[];
};

/**
 * 把这些单元转成 target。elements 是整个场景（含已删除），不会被改。
 * ids：文本 → 形状时新容器的 id（文字 id → 容器 id），同一轮 Tab 里反复转换要用同一个，没有就新建并记进去。
 */
export function convert(elements: readonly El[], units: readonly Unit[], target: Target, style: Style, ids = new Map<string, string>()): Result {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const next = new Map<string, El>();
  const get = (id: string) => next.get(id) ?? byId.get(id);
  const put = (e: El) => next.set(e.id, e);
  const below = new Map<string, string>();
  const select: string[] = [];
  // 连着这些元素的箭头，转换后要改连到谁、端点贴到哪
  const rebind = new Map<string, string>(); // 旧目标 id → 新目标 id
  const reshaped = new Set<string>(); // 轮廓变了的元素（转换后的 id）

  for (const u of units) {
    if (!changes(u, target)) {
      select.push(u.el.id);
      continue;
    }
    if (u.el.type === "text") {
      const c = wrapText(u.el, target as Exclude<Target, "text">, style, ids);
      put(c.container);
      put(c.text);
      below.set(c.container.id, c.text.id);
      rebind.set(u.el.id, c.container.id);
      reshaped.add(c.container.id);
      select.push(c.container.id);
    } else if (target === "text") {
      const t = unwrapText(u.el, u.text!);
      put(t);
      put(bump(u.el, { isDeleted: true, boundElements: u.el.boundElements?.filter((b) => b.id !== t.id) ?? null }));
      rebind.set(u.el.id, t.id);
      reshaped.add(t.id);
      select.push(t.id);
    } else {
      const shaped = bump(u.el, { type: target, roundness: u.el.roundness ? roundnessFor(target) : null });
      if (u.text) {
        const r = layoutLabel(shaped, u.text, u.text.originalText ?? u.text.text);
        put(r.container);
        if (r.text) put(r.text);
      } else put(shaped);
      reshaped.add(u.el.id);
      select.push(u.el.id);
    }
  }

  // 箭头：改连新目标，两头的 boundElements 跟着改；端点挪到新轮廓上
  const arrows = new Set<string>();
  for (const [from, to] of rebind) {
    const src = byId.get(from)!;
    const refs = (src.boundElements ?? []).filter((b) => b.type === "arrow" && !!byId.get(b.id) && !byId.get(b.id)!.isDeleted);
    if (!refs.length) continue;
    const dst = get(to)!;
    const have = new Set((dst.boundElements ?? []).map((b) => b.id));
    put({ ...dst, boundElements: [...(dst.boundElements ?? []), ...refs.filter((r) => !have.has(r.id))] });
    const s = get(from)!;
    if (s.id !== to) put({ ...s, boundElements: (s.boundElements ?? []).filter((b) => b.type !== "arrow") });
    for (const r of refs) {
      const a = get(r.id)!;
      const patch: Partial<El> = {};
      if (a.startBinding?.elementId === from) patch.startBinding = { ...a.startBinding, elementId: to };
      if (a.endBinding?.elementId === from) patch.endBinding = { ...a.endBinding, elementId: to };
      put(next.has(a.id) ? { ...a, ...patch } : bump(a, patch));
      arrows.add(a.id);
    }
  }
  for (const e of elements) {
    if (e.isDeleted || (e.type !== "arrow" && e.type !== "line")) continue;
    const ends = [e.startBinding?.elementId, e.endBinding?.elementId];
    if (ends.some((id) => id && reshaped.has(id))) arrows.add(e.id);
  }
  for (const id of arrows) {
    const a = get(id)!;
    const moved = reanchor(a, (bid) => (bid && reshaped.has(bid) ? get(bid) : undefined));
    if (moved !== a) put(next.has(id) ? { ...a, ...moved, version: a.version } : moved);
  }

  // 批注：指着被删掉的容器的，改指文字
  const retarget = [...rebind].filter(([from, to]) => get(from)?.isDeleted && !!get(to));
  if (retarget.length) {
    for (const e of elements) {
      const c = e.customData?.excalidesk?.comment;
      if (e.isDeleted || !Array.isArray(c?.targets)) continue;
      const targets = c.targets.map((t: string) => retarget.find(([from]) => from === t)?.[1] ?? t);
      if (targets.some((t: string, i: number) => t !== c.targets[i])) {
        put(bump(e, { customData: { ...e.customData, excalidesk: { ...e.customData!.excalidesk, comment: { ...c, targets } } } }));
      }
    }
  }
  return { changed: [...next.values()], below, select };
}

/** 文本 → 形状：按文字大小建容器，把文字绑进去，保留对齐方式 */
function wrapText(text: El, type: "rectangle" | "diamond" | "ellipse", style: Style, ids: Map<string, string>) {
  let id = ids.get(text.id);
  if (!id) ids.set(text.id, (id = randomId()));
  const value = text.originalText ?? text.text;
  // 存着的宽度可能是字体加载完之前量的（偏窄），按它建容器会多出换行：自动宽度的文字重新量一次。
  // 固定宽度（autoResize: false）的文字就按它的宽度换行，不重新量
  const m = text.autoResize === false ? text : relayoutText(text, value);
  const tw = Math.max(text.width, m.width), th = Math.max(text.height, m.height);
  const w = containerDim(tw, type), h = containerDim(th, type);
  // 重新量过变宽了：按对齐方式保持文字的左边 / 中线 / 右边不动
  const x0 = text.textAlign === "center" ? text.x + (text.width - tw) / 2 : text.textAlign === "right" ? text.x + text.width - tw : text.x;
  const cx = x0 + tw / 2, cy = text.y + th / 2;
  const [made] = convertToExcalidrawElements([{ type, id, x: cx - w / 2, y: cy - h / 2, width: w, height: h } as any], { regenerateIds: false }) as unknown as El[];
  const container: El = {
    ...made,
    strokeColor: text.strokeColor,
    backgroundColor: style.backgroundColor,
    fillStyle: style.fillStyle,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    roughness: style.roughness,
    opacity: text.opacity ?? 100,
    roundness: style.roundness === "round" ? roundnessFor(type) : null,
    angle: text.angle ?? 0,
    groupIds: text.groupIds ?? [],
    frameId: text.frameId ?? null,
    link: text.link ?? null,
    locked: false,
    boundElements: [],
  };
  const r = layoutLabel(container, text, value, { textAlign: text.textAlign, verticalAlign: "middle" });
  return { container: r.container, text: { ...r.text!, containerId: id, autoResize: true, link: null, boundElements: null } };
}

/** 形状 → 文本：文字回到没换行的原文，按对齐方式保持位置；顶边不动 */
function unwrapText(container: El, text: El): El {
  const t = relayoutText(text, text.originalText ?? text.text);
  const x = text.textAlign === "center" ? text.x + (text.width - t.width) / 2 : text.textAlign === "right" ? text.x + text.width - t.width : text.x;
  return { ...t, x, containerId: null, autoResize: true, verticalAlign: "top", link: text.link ?? container.link ?? null, boundElements: [] };
}

// ── 箭头端点 ────────────────────────────────────────────

type Pt = { x: number; y: number };

/** 射线 p + t·d（d 是单位向量）第一次碰到元素轮廓时的 t；p 在轮廓里面或碰不到时是 null */
export function hitOutline(e: El, p: Pt, d: Pt): number | null {
  const a = Math.abs(e.width) / 2, b = Math.abs(e.height) / 2;
  if (!(a > 0 && b > 0)) return null;
  const cx = Math.min(e.x, e.x + e.width) + a, cy = Math.min(e.y, e.y + e.height) + b;
  // 转到元素自己的坐标系（中心为原点、不旋转）
  const ang = -(e.angle ?? 0), cos = Math.cos(ang), sin = Math.sin(ang);
  const px = (p.x - cx) * cos - (p.y - cy) * sin, py = (p.x - cx) * sin + (p.y - cy) * cos;
  const dx = d.x * cos - d.y * sin, dy = d.x * sin + d.y * cos;
  if (e.type === "ellipse") {
    const A = (dx * dx) / (a * a) + (dy * dy) / (b * b), B = 2 * ((px * dx) / (a * a) + (py * dy) / (b * b)), C = (px * px) / (a * a) + (py * py) / (b * b) - 1;
    if (C <= 0 || !A) return null;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const t = (-B - Math.sqrt(disc)) / (2 * A);
    return t >= 0 ? t : null;
  }
  if (e.type === "diamond") {
    if (Math.abs(px) / a + Math.abs(py) / b <= 1) return null;
    const v = [{ x: 0, y: -b }, { x: a, y: 0 }, { x: 0, y: b }, { x: -a, y: 0 }];
    let best: number | null = null;
    for (let i = 0; i < 4; i++) {
      const s = v[i], q = v[(i + 1) % 4];
      const ex = q.x - s.x, ey = q.y - s.y, den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((s.x - px) * ey - (s.y - py) * ex) / den;
      const u = ((s.x - px) * dy - (s.y - py) * dx) / den;
      if (t >= 0 && u >= 0 && u <= 1 && (best === null || t < best)) best = t;
    }
    return best;
  }
  // 矩形、文字：按外框
  if (Math.abs(px) <= a && Math.abs(py) <= b) return null;
  let t0 = -Infinity, t1 = Infinity;
  for (const [o, dd, h] of [[px, dx, a], [py, dy, b]] as const) {
    if (Math.abs(dd) < 1e-12) {
      if (Math.abs(o) > h) return null;
      continue;
    }
    const u = (-h - o) / dd, w = (h - o) / dd;
    t0 = Math.max(t0, Math.min(u, w));
    t1 = Math.min(t1, Math.max(u, w));
  }
  return t0 <= t1 && t0 >= 0 ? t0 : null;
}

/** 连着的元素换了轮廓：两头端点沿最后一段的方向挪到新轮廓上（留原来的 gap），碰不到就朝中心。返回新箭头，没动就返回原来的 */
function reanchor(arrow: El, target: (id: string | undefined) => El | undefined): El {
  const pts: Pt[] = (arrow.points as [number, number][] | undefined)?.map(([x, y]) => ({ x: arrow.x + x, y: arrow.y + y })) ?? [];
  if (pts.length < 2 || arrow.angle) return arrow;
  let moved = false;
  for (const side of ["start", "end"] as const) {
    const binding = arrow[side === "start" ? "startBinding" : "endBinding"];
    const el = target(binding?.elementId);
    if (!el) continue;
    const i = side === "start" ? 0 : pts.length - 1;
    const from = pts[side === "start" ? 1 : pts.length - 2];
    const gap = typeof binding.gap === "number" ? binding.gap : PAD;
    const center = { x: el.x + el.width / 2, y: el.y + el.height / 2 };
    for (const toward of [pts[i], center]) {
      const len = Math.hypot(toward.x - from.x, toward.y - from.y);
      if (len < 1e-6) continue;
      const d = { x: (toward.x - from.x) / len, y: (toward.y - from.y) / len };
      const t = hitOutline(el, from, d);
      if (t === null) continue;
      const s = Math.max(t - gap, 0);
      pts[i] = { x: from.x + d.x * s, y: from.y + d.y * s };
      moved = true;
      break;
    }
  }
  if (!moved) return arrow;
  const x = pts[0].x, y = pts[0].y;
  const points = pts.map((p) => [p.x - x, p.y - y] as [number, number]);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return bump(arrow, { x, y, points, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
}

// ── 写回场景 ────────────────────────────────────────────

/** 把改过的元素并进场景：已有的原地替换，新建的插到 below 指定的元素下面 */
export function merge(scene: readonly El[], changed: readonly El[], below: ReadonlyMap<string, string> = new Map()): El[] {
  const map = new Map(changed.map((e) => [e.id, e]));
  const fresh = changed.filter((e) => !scene.some((s) => s.id === e.id));
  const under = new Map<string, El[]>();
  const tail: El[] = [];
  for (const e of fresh) {
    const anchor = below.get(e.id);
    if (anchor && scene.some((s) => s.id === anchor)) under.set(anchor, [...(under.get(anchor) ?? []), { ...e, index: null } as El]);
    else tail.push(e);
  }
  const out: El[] = [];
  for (const s of scene) {
    for (const e of under.get(s.id) ?? []) out.push(e);
    out.push(map.get(s.id) ?? s);
  }
  return [...out, ...tail];
}

/** 写之前把版本号抬到当前场景之上：合并（iCloud、外部修改、Agent）时版本高的胜出，转换结果不能输给转换途中的中间状态 */
export function lift(els: readonly El[], scene: readonly El[]): El[] {
  const cur = new Map(scene.map((e) => [e.id, e]));
  return els.map((e) => {
    const c = cur.get(e.id);
    return c && c !== e && c.version >= e.version ? ({ ...e, version: c.version + 1, versionNonce: nonce() } as El) : e;
  });
}

/**
 * 已删除、不连任何东西的样子。删掉的容器不能还在 boundElements 里登记着文字：
 * 打开文件和合并时 restoreElements({ repairBindings }) 不跳过已删除的容器，会把活着的文字绑回去，文字就再也点不中了
 */
export const unlinked = (e: El): El => ({ ...e, isDeleted: true, boundElements: [] });

/** 撤回到 original：这些 id 的元素恢复成 original 里的样子；original 里没有的（这一轮新建的容器）标成删除、去掉链接 */
export function revert(ids: Iterable<string>, original: readonly El[], scene: readonly El[]): El[] {
  const orig = new Map(original.map((e) => [e.id, e]));
  const cur = new Map(scene.map((e) => [e.id, e]));
  const out: El[] = [];
  for (const id of ids) {
    const c = cur.get(id);
    if (!c) continue;
    const o = orig.get(id);
    out.push({ ...(o ?? unlinked(c)), version: c.version + 1, versionNonce: nonce() } as El);
  }
  return out;
}
