// Agent（MCP）在前端的一半：Rust 发来 mcp-call，这里执行，再用 mcp_reply 回答。
// 需要 Excalidraw 本身的事都在这里：简化元素 → 真实元素、Mermaid、渲染 PNG、放进画布（可撤销、正常保存）。
// 同一张图的写操作排队执行；不同的图互不等待，所以多个 Agent 可以同时改各自的图，图不必在当前标签。
import { CaptureUpdateAction, convertToExcalidrawElements, exportToBlob, restoreElements } from "@excalidraw/excalidraw";
import { activate, openPath, sessions } from "./actions";
import {
  bump, boundTextOf, boxOf, commentOf, ext, isComment, isCommentLike, isOpenComment, layoutLabel, noteIdOf, pinPoint, randomId, relayoutText, REPLY_SEP, route, stamp, unionBox,
  type Box, type El,
} from "./elements";
import { t } from "./i18n";
import { inTauri, ipc } from "./ipc";
import type { DocSession } from "./session";
import { buildFrame, buildNotes, isFixedSlide, isNotesFrame, nextSlideBox, slidesOf } from "./slides";
import { getState, setState, toast, updateTab, type AgentView } from "./store";

type Files = Record<string, any>;
type Call = { id: number; op: string; args: any };

const snap = (s: DocSession) => s.snapshot() as unknown as { elements: El[]; files: Files; appState: any };
const live = (els: readonly El[]) => els.filter((e) => !e.isDeleted);
const isFrame = (e: El) => e.type === "frame" || e.type === "magicframe";
const findFrame = (els: readonly El[], key: string) => live(els).find((e) => isFrame(e) && (e.id === key || e.name === key));

// ── 入口 ───────────────────────────────────────────────

export async function initAgents() {
  if (!inTauri) {
    setState({ agents: await ipc.mcpReady() });
    return;
  }
  const { listen } = await import("@tauri-apps/api/event");
  await listen<Call>("mcp-call", (e) => void handle(e.payload));
  await listen<AgentView[]>("mcp-agents", (e) => {
    setState({ agents: e.payload });
    if (MCP_SELFTEST) void playUser(e.payload);
  });
  await listen<{ path: string; agent: string }>("mcp-feedback-read", (e) => toast(t("agent.read", { agent: e.payload.agent })));
  setState({ agents: await ipc.mcpReady() });
}

const queues = new Map<string, Promise<unknown>>();
/** 同一张图的操作按顺序来 */
function serial<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(path, run.catch(() => {}));
  return run;
}

const OPS: Record<string, (a: any) => Promise<unknown>> = { flush, open, draw, mermaid, update, delete: remove, resolve, render };
const READS = new Set(["flush", "render"]);
// 开发模式和自测：不经过 MCP 直接跑一个操作
export const runOp = (op: string, args: any) => (READS.has(op) ? OPS[op](args) : serial(args.path, () => OPS[op](args)));
if (import.meta.env.DEV) (window as any).__agent = { op: runOp, sessions, openPath };

async function handle({ id, op, args }: Call) {
  try {
    const fn = OPS[op];
    if (!fn) throw new Error(`unknown op ${op}`);
    const value = READS.has(op) ? await fn(args) : await serial(args.path, () => fn(args));
    await ipc.mcpReply(id, true, value ?? {});
  } catch (e) {
    await ipc.mcpReply(id, false, e instanceof Error ? e.message : String(e));
  }
}

/** 图没打开就在后台标签里打开（不抢走用户正在看的那张） */
async function ensureSession(path: string, focus = false): Promise<DocSession> {
  if (!sessions.has(path)) await openPath(path, { background: !focus });
  else if (focus) await activate(path);
  const s = sessions.get(path);
  // 用户这时可能正在打开它（iCloud 还在下载）：等打开完再动
  if (s) await s.loading;
  const tab = getState().tabs.find((x) => x.path === path);
  if (!s || !tab) throw new Error(`couldn't open ${path}`);
  alive(s);
  if (tab.phase !== "ready") throw new Error(tab.error ?? `couldn't open ${path}`);
  if (s.missing) throw new Error(`${path} was moved or deleted; the user has to decide what to do with it first`);
  return s;
}

/** 等待期间用户关掉（或关掉又重开）了这张图：别改到已经没人用的旧会话上 */
function alive(s: DocSession) {
  if (sessions.get(s.path) !== s) throw new Error(`the user closed ${s.path} while you were working on it; call the tool again`);
}

/** 写操作的开头：等保存、留历史；之后到 applyAgent 之间必须是同步的 */
async function begin(s: DocSession) {
  await s.beginAgent();
  alive(s);
}

function banner(s: DocSession, agent: string, label: string) {
  updateTab(s.path, {
    banner: `${agent} ${label}`,
    bannerAction: {
      label: t("agent.undo"),
      run: async () => {
        if (await s.undoAgent()) updateTab(s.path, { banner: t("agent.undone", { agent }), bannerAction: undefined });
      },
    },
    agentDot: getState().active !== s.path,
  });
}

// ── 读 ─────────────────────────────────────────────────

async function flush({ path }: { path: string }) {
  const s = sessions.get(path);
  if (s) await s.flush();
  return { open: !!s };
}

async function open({ path, focus }: { path: string; focus?: boolean }) {
  await ensureSession(path, !!focus);
  return {};
}

function pngSize(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

function base64(b: Uint8Array) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

async function render(a: { path: string; frame?: string; ids?: string[]; maxSize?: number; comments?: boolean; scene?: string }) {
  let els: El[];
  let files: Files;
  let bg: string | undefined;
  const s = sessions.get(a.path);
  if (s) await s.loading;
  if (s) {
    const sn = snap(s);
    els = sn.elements;
    files = sn.files;
    bg = sn.appState.viewBackgroundColor;
  } else {
    const d = a.scene?.trim() ? JSON.parse(a.scene) : {};
    els = restoreElements(d.elements ?? [], null, { repairBindings: true }) as unknown as El[];
    files = d.files ?? {};
    bg = d.appState?.viewBackgroundColor;
  }
  els = live(els);
  if (a.comments === false) els = els.filter((e) => !isCommentLike(e));
  let exportingFrame: El | null = null;
  if (a.frame) {
    const f = findFrame(els, a.frame);
    if (!f) throw new Error(`no frame named or with id "${a.frame}"`);
    exportingFrame = f;
    els = els.filter((e) => e.id === f.id || e.frameId === f.id);
  }
  if (a.ids?.length) {
    const want = new Set(a.ids);
    els = els.filter((e) => want.has(e.id) || (e.containerId && want.has(e.containerId)));
  }
  if (!els.length) throw new Error("nothing to render: the drawing (or selection) is empty");
  const max = Math.min(Math.max(a.maxSize ?? 1600, 200), 3000);
  const blob = await exportToBlob({
    elements: els as any,
    appState: { exportBackground: true, viewBackgroundColor: bg ?? "#ffffff", exportWithDarkMode: false } as any,
    files: files as any,
    mimeType: "image/png",
    exportPadding: 24,
    exportingFrame: exportingFrame as any,
    getDimensions: (w: number, h: number) => {
      const scale = Math.min(2, max / Math.max(w, h));
      return { width: Math.round(w * scale), height: Math.round(h * scale), scale };
    },
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { png: base64(bytes), ...pngSize(bytes) };
}

// ── 摆放 ───────────────────────────────────────────────

/** 新内容的原点：指定的 at；加进已有 frame 时放在它里面已有内容的下方；否则放在现有内容右边 */
function origin(cur: readonly El[], at: { x: number; y: number } | undefined, frameEl: El | undefined) {
  if (at) return at;
  if (frameEl) {
    const inside = unionBox(live(cur).filter((e) => e.frameId === frameEl.id));
    return { x: frameEl.x + 40, y: inside ? inside.y + inside.h + 60 : frameEl.y + 40 };
  }
  const b = unionBox(live(cur));
  return b ? { x: b.x + b.w + 200, y: b.y } : { x: 0, y: 0 };
}

const PAD = 48;

/** 把新元素放进 frame：新建一个（包住它们），或者加进已有的（必要时把它撑大，否则超出部分会被裁掉） */
function frameUp(newEls: El[], frame: string | undefined, frameEl: El | undefined) {
  const changed: El[] = [];
  if (!frame) return { newEls, changed, frameId: undefined as string | undefined };
  const box = unionBox(newEls)!;
  if (frameEl) {
    const fb = boxOf(frameEl);
    const x0 = Math.min(fb.x, box.x - PAD), y0 = Math.min(fb.y, box.y - PAD);
    const x1 = Math.max(fb.x + fb.w, box.x + box.w + PAD), y1 = Math.max(fb.y + fb.h, box.y + box.h + PAD);
    if (x0 < fb.x || y0 < fb.y || x1 > fb.x + fb.w || y1 > fb.y + fb.h) changed.push(bump(frameEl, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
    return { newEls: newEls.map((e) => ({ ...e, frameId: frameEl.id })), changed, frameId: frameEl.id };
  }
  const frameId = randomId();
  const [r] = convertToExcalidrawElements(
    [{ type: "rectangle", id: frameId, x: box.x - PAD, y: box.y - PAD, width: box.w + PAD * 2, height: box.h + PAD * 2 } as any],
    { regenerateIds: false },
  ) as unknown as El[];
  const f: El = { ...r, type: "frame", name: frame, roundness: null, backgroundColor: "transparent", strokeColor: "#bbb", boundElements: null };
  return { newEls: [f, ...newEls.map((e) => ({ ...e, frameId }))], changed, frameId };
}

// ── 幻灯片（docs/specs/20261117-presentation-mode.md）──

/**
 * 这次要画到哪一页：slide 且没有这个 frame → 新建一页固定尺寸的页（接在最后一页右边）；
 * 加进已有的固定页，或者 slide 指定了已有的 frame → 就是它。其他情况不是「页」，走原来的 frame 逻辑（会撑大）。
 */
function pageFor(cur: readonly El[], a: { slide?: boolean; frame?: string; at?: unknown }, frameEl: El | undefined) {
  if (a.slide && a.at) throw new Error("`at` doesn't go with `slide`: coordinates are relative to the slide's top-left, and the slide is 1920×1080");
  if (a.slide && frameEl && isNotesFrame(frameEl)) throw new Error(`"${a.frame}" is a speaker-notes frame, not a slide; pass the slide's name and put the text in \`notes\``);
  if (a.slide && !frameEl) return { page: buildFrame(nextSlideBox(cur), a.frame ?? `Slide ${slidesOf(cur).length + 1}`, { slide: true }), isNew: true };
  if (frameEl && (a.slide || isFixedSlide(frameEl))) return { page: frameEl, isNew: false };
  return null;
}

/** 放进页里：页不撑大（新页带上 frame 本身） */
function intoPage(newEls: El[], page: El, isNew: boolean) {
  return { newEls: [...(isNew ? [page] : []), ...newEls.map((e) => ({ ...e, frameId: page.id }))], changed: [] as El[], frameId: page.id };
}

/** 线和箭头按点算范围，其他按 x / y / 宽高 */
function extent(e: El): Box {
  if (!Array.isArray(e.points) || !e.points.length) return boxOf(e);
  const xs = e.points.map((p: number[]) => e.x + p[0]), ys = e.points.map((p: number[]) => e.y + p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** 超出页边的元素：放映和 PDF 里会被裁掉 */
function overflowOf(els: readonly El[], page: El) {
  const p = boxOf(page);
  return els
    .filter((e) => e.id !== page.id && !(e.type === "text" && e.containerId) && !isFrame(e))
    .filter((e) => {
      const b = extent(e);
      return b.x < p.x - 0.5 || b.y < p.y - 0.5 || b.x + b.w > p.x + p.w + 0.5 || b.y + b.h > p.y + p.h + 0.5;
    })
    .map((e) => e.id);
}
const OVERFLOW_HINT = "These elements stick out of the slide and get cut off when presenting and in the PDF; move them inside (the slide is its frame's width × height) or make them smaller.";

/**
 * 写这一页的演讲者备注：没有备注 frame 就在页下方建一个；有就替换里面那段文字（文字变长就把备注 frame 撑高）。
 * 返回要新建的、要改的元素和放文字的那个元素的 id。
 */
function writeNotes(cur: readonly El[], page: El, isNew: boolean, text: string) {
  const own = isNew ? undefined : slidesOf(cur).find((s) => s.frame.id === page.id)?.notes[0];
  if (!own) {
    const made = buildNotes(page, text);
    return { created: made.elements, changed: [] as El[], id: made.holder.id };
  }
  const byId = new Map(cur.map((e) => [e.id, e]));
  const inside = live(cur).filter((e) => e.frameId === own.id && !isCommentLike(e));
  const holder = inside.find((e) => e.type !== "text" && boundTextOf(e, byId)) ?? inside.find((e) => e.type === "text" && !e.containerId);
  const changed: El[] = [];
  let id: string;
  if (!holder) {
    // 备注 frame 是空的：在里面放一段
    // buildNotes 把它放在 own 的下方，挪回 own 里面
    const made = buildNotes(own, text);
    const [, ...inner] = made.elements;
    const dy = own.y + 40 - made.holder.y;
    const created = inner.map((e) => ({ ...e, y: e.y + dy, frameId: own.id }));
    return { created, changed, id: made.holder.id };
  }
  if (holder.type === "text") {
    const next = relayoutText(holder, text);
    changed.push(next);
    id = next.id;
  } else {
    const r = layoutLabel(holder, boundTextOf(holder, byId), text);
    changed.push(r.container);
    if (r.text) changed.push(r.text);
    id = r.container.id;
  }
  const box = unionBox(changed)!;
  if (box.y + box.h + 40 > own.y + own.height) changed.push(bump(own, { height: box.y + box.h + 40 - own.y }));
  return { created: [] as El[], changed, id };
}

function styled(sk: any[], style?: string) {
  if (style !== "clean") return sk;
  return sk.map((e) => ({
    roughness: 0,
    ...e,
    ...(e.type === "text" ? { fontFamily: e.fontFamily ?? 2 } : {}),
    ...(e.label ? { label: { fontFamily: 2, ...e.label } } : {}),
  }));
}

const shapeCount = (els: El[]) => els.filter((e) => !(e.type === "text" && e.containerId) && !isFrame(e)).length;

// ── 写 ─────────────────────────────────────────────────

type DrawArgs = { path: string; agent: string; elements: any[]; frame?: string; at?: { x: number; y: number }; style?: string; slide?: boolean; notes?: string };

async function draw(a: DrawArgs) {
  if (!Array.isArray(a.elements)) throw new Error("`elements` must be an array");
  // 只建一页、只写备注的时候可以不带元素
  if (!a.elements.length && !a.slide) throw new Error("`elements` is empty");
  if (a.notes != null && !a.slide) throw new Error("`notes` only goes with `slide: true`");
  const s = await ensureSession(a.path);
  await begin(s);
  // 从这里到 applyAgent 都是同步的：读到的画布就是放进去那一刻的画布
  const { elements: cur } = snap(s);
  const byId = new Map(cur.map((e) => [e.id, e]));
  const batch = new Set<string>();
  const back: string[] = [];
  for (const e of a.elements) {
    if (!e || typeof e !== "object" || typeof e.type !== "string") throw new Error("every element needs a `type`");
    if (e.order != null && e.order !== "back" && e.order !== "front") throw new Error(`"order" is "back" or "front", not ${JSON.stringify(e.order)}`);
    if (e.id != null) {
      // 删掉的元素在文件里还留着（标成已删除）：它的 id 可以再用
      if (byId.has(e.id) && !byId.get(e.id)!.isDeleted) throw new Error(`id "${e.id}" is already used in this drawing; pick another id, or use update_elements to change it`);
      if (batch.has(e.id)) throw new Error(`id "${e.id}" appears twice`);
      batch.add(e.id);
    }
  }
  const frameEl = a.frame ? findFrame(cur, a.frame) : undefined;
  const pg = pageFor(cur, a, frameEl);
  const o = pg ? { x: pg.page.x, y: pg.page.y } : origin(cur, a.at, frameEl);
  const sk: any[] = styled(
    a.elements.map((e) => {
      const { order, ...rest } = structuredClone(e);
      const id = e.id ?? randomId();
      if (order === "back") back.push(id);
      return { ...rest, id, x: (Number(e.x) || 0) + o.x, y: (Number(e.y) || 0) + o.y };
    }),
    a.style,
  );

  // 指向 id 的箭头自己走线、自己绑定：这样也能连到画布上已有的元素（Excalidraw 的转换只认同一批里的）
  const isLine = (e: any) => e.type === "arrow" || e.type === "line";
  const linked = sk.filter((e) => isLine(e) && (e.start?.id || e.end?.id));
  const others = sk.filter((e) => !linked.includes(e));
  const boxes = new Map<string, Box>();
  for (const e of live(cur)) boxes.set(e.id, boxOf(e));
  for (const e of convertToExcalidrawElements(structuredClone(others), { regenerateIds: false }) as unknown as El[]) boxes.set(e.id, boxOf(e));
  const binds: { arrow: string; start?: string; end?: string }[] = [];
  for (const l of linked) {
    const sid: string | undefined = l.start?.id, eid: string | undefined = l.end?.id;
    for (const r of [sid, eid]) if (r && !boxes.has(r)) throw new Error(`arrow "${l.id}": no element with id "${r}"`);
    if (!l.points) {
      const here: Box = { x: l.x, y: l.y, w: 0, h: 0 };
      Object.assign(l, route(sid ? boxes.get(sid)! : here, eid ? boxes.get(eid)! : here));
    }
    binds.push({ arrow: l.id, start: sid, end: eid });
    delete l.start;
    delete l.end;
  }
  const out = new Map((convertToExcalidrawElements([...others, ...linked], { regenerateIds: false }) as unknown as El[]).map((e) => [e.id, e]));
  const existing = new Map<string, El>();
  for (const b of binds) {
    let arrow = out.get(b.arrow)!;
    for (const [side, tid] of [["startBinding", b.start], ["endBinding", b.end]] as const) {
      if (!tid) continue;
      arrow = { ...arrow, [side]: { elementId: tid, focus: 0, gap: 6 } };
      const target = out.get(tid) ?? existing.get(tid) ?? byId.get(tid)!;
      const be = target.boundElements ?? [];
      if (be.some((x) => x.id === arrow.id)) continue;
      const next = { ...target, boundElements: [...be, { id: arrow.id, type: "arrow" }] };
      if (out.has(tid)) out.set(tid, next);
      else existing.set(tid, existing.has(tid) ? next : bump(next));
    }
    out.set(arrow.id, arrow);
  }
  const placed = pg ? intoPage([...out.values()], pg.page, pg.isNew) : frameUp([...out.values()], a.frame, frameEl);
  for (const e of placed.changed) existing.set(e.id, e);
  const notes = pg && a.notes != null ? writeNotes(cur, pg.page, pg.isNew, String(a.notes)) : null;
  if (notes) {
    placed.newEls.push(...notes.created);
    for (const e of notes.changed) existing.set(e.id, e);
  }
  // 复用的 id：版本压过那条删除记录（合并时才赢）。删除记录还占着原来的位置，
  // 所以这一批新画的（不只是复用的）都按请求里的先后重新放到最上面，保证「后画的在上面」
  const reused = placed.newEls.some((e) => byId.get(e.id)?.isDeleted);
  const created = placed.newEls.map((e) => {
    const old = byId.get(e.id);
    return stamp(old?.isDeleted ? { ...e, version: Math.max(e.version, old.version) + 1 } : e, a.agent);
  });
  const front = reused ? sk.map((e) => e.id).filter((id) => !back.includes(id)) : [];
  await s.applyAgent([...existing.values(), ...created], {}, a.agent, back.length || front.length ? { back, front } : undefined);
  banner(s, a.agent, existing.size && !created.length ? t("agent.changed", { n: existing.size }) : t("agent.drew", { n: shapeCount(created) }));
  const box = unionBox(created) ?? unionBox([...existing.values()]) ?? boxOf(pg!.page);
  // 备注本来就在页外面
  const noteIds = new Set(notes?.created.map((e) => e.id));
  const overflow = pg ? overflowOf(created.filter((e) => !noteIds.has(e.id)), pg.page) : [];
  return {
    ids: [...created.map((e) => e.id), ...existing.keys()],
    created: created.filter((e) => !(e.type === "text" && e.containerId)).map((e) => e.id),
    frame: placed.frameId,
    bounds: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) },
    ...(pg ? { slide: pg.page.id, ...(notes ? { notes: notes.id } : {}) } : {}),
    ...(overflow.length ? { overflow, overflowHint: OVERFLOW_HINT } : {}),
  };
}

async function mermaid(a: { path: string; agent: string; mermaid: string; frame?: string; at?: { x: number; y: number }; style?: string; slide?: boolean }) {
  if (!a.mermaid?.trim()) throw new Error("`mermaid` is empty");
  const s = await ensureSession(a.path);
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  let parsed;
  try {
    parsed = await parseMermaidToExcalidraw(a.mermaid, { themeVariables: { fontSize: "16px" } } as any);
  } catch (e) {
    throw new Error(`Mermaid didn't parse: ${e instanceof Error ? e.message : e}`);
  }
  const conv = convertToExcalidrawElements(styled(parsed.elements as any[], a.style), { regenerateIds: true }) as unknown as El[];
  if (!conv.length) throw new Error("the diagram came out empty");
  await begin(s);
  const { elements: cur } = snap(s);
  const frameEl = a.frame ? findFrame(cur, a.frame) : undefined;
  const pg = pageFor(cur, a, frameEl);
  const b = unionBox(conv)!;
  let o: { x: number; y: number };
  if (pg) {
    // 页里：水平居中，放在页里已有内容的下方；空页就上下也居中
    const inside = pg.isNew ? null : unionBox(live(cur).filter((e) => e.frameId === pg.page.id));
    o = { x: pg.page.x + (pg.page.width - b.w) / 2, y: inside ? inside.y + inside.h + 60 : pg.page.y + Math.max(60, (pg.page.height - b.h) / 2) };
  } else o = origin(cur, a.at, frameEl);
  const moved = conv.map((e) => ({ ...e, x: e.x - b.x + o.x, y: e.y - b.y + o.y }));
  const placed = pg ? intoPage(moved, pg.page, pg.isNew) : frameUp(moved, a.frame, frameEl);
  const existing = new Map(placed.changed.map((e) => [e.id, e]));
  const created = placed.newEls.map((e) => stamp(e, a.agent));
  await s.applyAgent([...existing.values(), ...created], (parsed.files ?? {}) as Files, a.agent);
  banner(s, a.agent, t("agent.drew", { n: shapeCount(created) }));
  const box = unionBox(created)!;
  const overflow = pg ? overflowOf(created, pg.page) : [];
  return {
    ids: [...created.map((e) => e.id), ...existing.keys()],
    created: created.filter((e) => !(e.type === "text" && e.containerId)).map((e) => e.id),
    frame: placed.frameId,
    bounds: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) },
    ...(pg ? { slide: pg.page.id } : {}),
    ...(overflow.length ? { overflow, overflowHint: OVERFLOW_HINT } : {}),
  };
}

const STYLE_KEYS = ["strokeColor", "backgroundColor", "fillStyle", "strokeStyle", "strokeWidth", "roughness", "opacity", "link", "locked"];
const ARROWHEADS = ["startArrowhead", "endArrowhead"];
const UPDATE_KEYS = new Set(["id", "x", "y", "width", "height", "text", "fontSize", "name", "order", ...STYLE_KEYS, ...ARROWHEADS]);
type Ignored = { id: string; fields: string[]; why: string };

async function update(a: { path: string; agent: string; updates: any[] }) {
  if (!Array.isArray(a.updates) || !a.updates.length) throw new Error("`updates` is empty");
  const s = await ensureSession(a.path);
  await begin(s);
  const { elements: cur } = snap(s);
  const byId = new Map(cur.map((e) => [e.id, e]));
  const changed = new Map<string, El>();
  const get = (id: string) => changed.get(id) ?? byId.get(id);
  const view = { get: (id: string) => get(id) } as unknown as Map<string, El>;
  const missing: string[] = [];
  // 没生效的字段要说出来，别让 Agent 以为改成功了
  const ignored: Ignored[] = [];
  // 同一个元素在一批里调了几次：最后一次算数
  const sides = new Map<string, "back" | "front">();
  // 挪页时它的备注跟着走（这一批里也明确挪了备注的除外）
  const notesOf = new Map(slidesOf(cur).map((sl) => [sl.frame.id, sl.notes]));
  const named = new Set(a.updates.map((u) => u?.id));
  for (const u0 of a.updates) {
    let el = u0?.id ? get(u0.id) : undefined;
    if (!el || el.isDeleted) {
      missing.push(String(u0?.id));
      continue;
    }
    if (isCommentLike(el)) throw new Error(`"${u0.id}" is part of the user's comment; use resolve_comments instead`);
    // 改容器里的文字 = 改容器的标签
    if (el.type === "text" && el.containerId && get(el.containerId)) el = get(el.containerId)!;
    const u = { ...u0 };
    const drop = (keys: string[], why: string) => {
      const hit = keys.filter((k) => k in u);
      if (!hit.length) return;
      hit.forEach((k) => delete u[k]);
      ignored.push({ id: u0.id, fields: hit, why });
    };
    drop(Object.keys(u).filter((k) => !UPDATE_KEYS.has(k)), "not a field update_elements can change");
    if (isFrame(el)) {
      drop(["backgroundColor", "fillStyle"], 'frames have no fill; draw a rectangle inside the frame and give it order "back"');
      drop(["text", "fontSize"], "a frame's title is its `name`");
      drop(["order"], "frames can't be reordered; reorder the elements inside instead");
    } else drop(["name"], "only frames have a `name`; use `text` for a shape's label");
    if (el.type !== "arrow" && el.type !== "line") drop(ARROWHEADS, "only arrows and lines have arrowheads");
    if ("order" in u) {
      if (u.order === "back" || u.order === "front") {
        sides.delete(el.id);
        sides.set(el.id, u.order);
      }
      else drop(["order"], 'order is "back" or "front"');
    }
    const patch: Record<string, any> = {};
    for (const k of [...STYLE_KEYS, ...ARROWHEADS]) if (k in u) patch[k] = u[k];
    if ("name" in u) patch.name = u.name;
    if ("width" in u) patch.width = Number(u.width);
    if ("height" in u) patch.height = Number(u.height);
    const dx = "x" in u ? Number(u.x) - el.x : 0;
    const dy = "y" in u ? Number(u.y) - el.y : 0;
    patch.x = el.x + dx;
    patch.y = el.y + dy;
    changed.set(el.id, bump(el, patch));
    if (dx || dy) {
      // 标签跟着容器走，frame 里的东西跟着 frame 走（包括这一批里刚加的标签）
      const added = [...changed.values()].filter((e) => !byId.has(e.id) && !e.isDeleted);
      for (const f of [...live(cur), ...added]) {
        if (f.containerId === el.id || (isFrame(el) && f.frameId === el.id)) {
          const g = get(f.id)!;
          changed.set(f.id, bump(g, { x: g.x + dx, y: g.y + dy }));
        }
      }
      for (const n of notesOf.get(el.id) ?? []) {
        if (named.has(n.id)) continue;
        for (const f of live(cur)) {
          if (f.id === n.id || f.frameId === n.id || (f.containerId && byId.get(f.containerId)?.frameId === n.id && f.frameId !== n.id)) {
            const g = get(f.id)!;
            changed.set(f.id, bump(g, { x: g.x + dx, y: g.y + dy }));
          }
        }
      }
    }
    const target = changed.get(el.id)!;
    const resized = "width" in u || "height" in u;
    if ("text" in u || "fontSize" in u || resized) {
      if (target.type === "text") {
        if ("text" in u || "fontSize" in u) changed.set(target.id, relayoutText(target, String(u.text ?? target.originalText ?? target.text), u.fontSize));
      } else {
        const t0 = boundTextOf(target, view);
        if (t0 || "text" in u) {
          const r = layoutLabel(target, t0, String(u.text ?? t0?.originalText ?? ""), { fontSize: u.fontSize });
          changed.set(r.container.id, r.container);
          if (r.text) changed.set(r.text.id, r.text);
        }
      }
    }
  }
  // 两端都绑着的直线箭头：被连的元素动了就重新走线
  for (const arrow of live(cur)) {
    if (arrow.type !== "arrow" || arrow.points?.length !== 2) continue;
    const sid = arrow.startBinding?.elementId, eid = arrow.endBinding?.elementId;
    if (!sid || !eid || (!changed.has(sid) && !changed.has(eid))) continue;
    const sa = get(sid), ea = get(eid);
    if (!sa || !ea) continue;
    const r = route(boxOf(sa), boxOf(ea));
    const next = bump(get(arrow.id)!, { ...r, width: Math.abs(r.points[1][0]), height: Math.abs(r.points[1][1]) });
    changed.set(arrow.id, next);
    const label = boundTextOf(next, view);
    if (label) {
      const l = layoutLabel(next, label, label.originalText ?? label.text);
      changed.set(arrow.id, l.container);
      if (l.text) changed.set(label.id, l.text);
    }
  }
  if (changed.size) {
    // 新加的标签不在 cur 里，所以交出去的是 changed 本身
    const pick = (side: string) => [...sides].filter(([, v]) => v === side).map(([id]) => id);
    await s.applyAgent([...changed.values()], {}, a.agent, sides.size ? { back: pick("back"), front: pick("front") } : undefined);
    banner(s, a.agent, t("agent.changed", { n: a.updates.length - missing.length }));
  }
  return {
    ids: [...changed.keys()],
    updated: a.updates.map((u) => u?.id).filter((id) => id && !missing.includes(id)),
    missing,
    ...(ignored.length ? { ignored } : {}),
  };
}

async function remove(a: { path: string; agent: string; ids: string[] }) {
  if (!Array.isArray(a.ids) || !a.ids.length) throw new Error("`ids` is empty");
  const s = await ensureSession(a.path);
  await begin(s);
  const { elements: cur } = snap(s);
  const byId = new Map(cur.map((e) => [e.id, e]));
  const del = new Set<string>();
  // 用户把批注拖进了要删的 frame：批注留下，只是不再属于那个 frame
  const unframe = new Set<string>();
  const missing: string[] = [];
  for (const id of a.ids) {
    const el = byId.get(id);
    if (!el || el.isDeleted) {
      missing.push(id);
      continue;
    }
    if (isCommentLike(el)) throw new Error(`"${id}" is part of the user's comment; use resolve_comments instead`);
    del.add(id);
    for (const e of live(cur)) {
      if (!(e.containerId === id || (isFrame(el) && e.frameId === id))) continue;
      if (isCommentLike(e)) unframe.add(e.id);
      else del.add(e.id);
    }
  }
  // frame 里的元素再带上它们的标签
  for (const e of live(cur)) if (e.containerId && del.has(e.containerId) && !isCommentLike(e)) del.add(e.id);
  if (del.size) {
    const patch = [...[...del].map((id) => bump(byId.get(id)!, { isDeleted: true })), ...[...unframe].map((id) => bump(byId.get(id)!, { frameId: null }))];
    await s.applyAgent(patch, {}, a.agent);
    banner(s, a.agent, t("agent.deleted", { n: a.ids.length - missing.length }));
  }
  return { ids: [...del], deleted: a.ids.filter((id) => !missing.includes(id)), missing };
}

async function resolve(a: { path: string; agent: string; comments: { id: string; reply?: string }[] }) {
  if (!Array.isArray(a.comments) || !a.comments.length) throw new Error("`comments` is empty");
  const s = await ensureSession(a.path);
  await begin(s);
  const { elements: cur } = snap(s);
  const byId = new Map(cur.map((e) => [e.id, e]));
  const changed = new Map<string, El>();
  const view = { get: (id: string) => changed.get(id) ?? byId.get(id) } as unknown as Map<string, El>;
  const missing: string[] = [];
  for (const c of a.comments) {
    const note = byId.get(c.id);
    if (!note || note.isDeleted || !isComment(note)) {
      missing.push(c.id);
      continue;
    }
    const meta = { ...ext(note)!.comment, status: "resolved", reply: c.reply ?? null, resolvedBy: a.agent, resolvedAt: Date.now() };
    let n2 = bump(note, {
      backgroundColor: "#e9ecef",
      strokeColor: "#adb5bd",
      opacity: 70,
      customData: { ...note.customData, excalidesk: { ...ext(note), comment: meta } },
    });
    const t0 = boundTextOf(note, view);
    if (t0) {
      const original = String(t0.originalText ?? t0.text).split(REPLY_SEP)[0];
      const value = c.reply?.trim() ? `${original}${REPLY_SEP}✓ ${a.agent}: ${c.reply.trim()}` : `${original}${REPLY_SEP}✓ ${a.agent}`;
      const r = layoutLabel(n2, t0, value, { strokeColor: "#868e96" });
      n2 = r.container;
      if (r.text) changed.set(r.text.id, { ...r.text, strokeColor: "#868e96", opacity: 80 });
    }
    changed.set(n2.id, n2);
    for (const e of live(cur)) if (commentOf(e) === note.id && e.type === "arrow") changed.set(e.id, bump(e, { strokeColor: "#adb5bd", opacity: 60 }));
  }
  if (changed.size) {
    await s.applyAgent([...changed.values()], {}, a.agent);
    banner(s, a.agent, t("agent.resolved",{ n: a.comments.length - missing.length }));
  }
  return { ids: [...changed.keys()], resolved: a.comments.map((c) => c.id).filter((id) => !missing.includes(id)), missing };
}

// ── 端到端自测（--mcp-selftest）：替用户批注并点「发回」 ──

const MCP_SELFTEST = new URLSearchParams(location.search).get("mcpselftest") === "1";
/** 只演一次：之后的 wait_for_feedback 用来测超时 */
let played = false;
async function playUser(agents: AgentView[]) {
  const a = agents.find((x) => x.status === "waiting" && x.files[0]);
  if (!a || played) return;
  played = true;
  const path = a.files[0];
  await activate(path);
  let s = sessions.get(path);
  for (let i = 0; i < 50 && !s?.api; i++) {
    await new Promise((r) => setTimeout(r, 100));
    s = sessions.get(path);
  }
  if (!s?.api) return;
  const target = (s.api.getSceneElements() as El[]).find((e) => e.id === "login");
  s.api.updateScene({ appState: { selectedElementIds: target ? { [target.id]: true } : {} }, captureUpdate: CaptureUpdateAction.NEVER });
  await new Promise((r) => setTimeout(r, 150));
  startComment(s);
  commitComment("make the button green");
  await new Promise((r) => setTimeout(r, 300));
  await sendToAgent(path);
}

// ── 用户这一侧：批注、发回 ─────────────────────────────

/** 新建批注的样子；处理过的批注重新打开时也恢复成这样 */
const NOTE = { bg: "#ffec99", stroke: "#f08c00", text: "#1e1e1e" };

/** 选中的正好是一条批注（便签、里面的文字、箭头，或者整组）：返回它；混着别的元素、或者选了几条批注都不算 */
function selectedNote(api: any): El | null {
  const st = api.getAppState();
  const byId = new Map((api.getSceneElements() as El[]).map((e) => [e.id, e]));
  const picked = Object.keys(st.selectedElementIds ?? {}).filter((id) => st.selectedElementIds[id]);
  const notes = new Set<string>();
  for (const id of picked) {
    const e = byId.get(id);
    const n = e && noteIdOf(e);
    if (!n) return null;
    notes.add(n);
  }
  const [only] = notes;
  return notes.size === 1 ? (byId.get(only) ?? null) : null;
}

/** 按 C：选中的是一条批注就改它；否则给选中的元素（没选就是画布中间）开一个新批注输入框 */
export function startComment(s: DocSession) {
  const api = s.api;
  if (!api) return;
  const note = selectedNote(api);
  if (note) return editComment(s, note.id);
  const st = api.getAppState();
  const els = api.getSceneElements() as El[];
  const byId = new Map(els.map((e) => [e.id, e]));
  const picked = Object.keys(st.selectedElementIds ?? {}).filter((id) => st.selectedElementIds[id]);
  const targets = [...new Set(picked.map((id) => byId.get(id)?.containerId ?? id))].filter((id) => {
    const e = byId.get(id);
    return e && !isCommentLike(e);
  });
  const box = unionBox(targets.map((id) => byId.get(id)!));
  const zoom = st.zoom.value;
  const scene = box
    ? { x: box.x + box.w + 56, y: box.y }
    : { x: st.width / 2 / zoom - st.scrollX - 120, y: st.height / 2 / zoom - st.scrollY - 40 };
  setState({ commentDraft: { path: s.path, targets, scene } });
}

/** 一条批注的原文（去掉 Agent 处理时追加的回复）和它的箭头 */
function noteParts(els: readonly El[], note: El) {
  const byId = new Map(els.map((e) => [e.id, e]));
  const text = boundTextOf(note, byId);
  const arrow = els.find((e) => !e.isDeleted && e.type === "arrow" && commentOf(e) === note.id);
  return { text, arrow, original: String(text?.originalText ?? text?.text ?? "").split(REPLY_SEP)[0] };
}

/** 打开已有批注的输入框（C、点收起后的小圆点、「下一条批注」）：展开时盖在便签上，收起时贴着小圆点 */
export function editComment(s: DocSession, noteId: string) {
  if (!s.api) return;
  const els = s.snapshot().elements as El[];
  const note = els.find((e) => e.id === noteId);
  if (!note || note.isDeleted || !isComment(note)) return;
  const { arrow, original } = noteParts(els, note);
  const meta = ext(note)!.comment;
  const pin = pinPoint(note, arrow);
  const scene = getState().notesFolded ? { x: pin.x + 10, y: pin.y + 10 } : { x: note.x, y: note.y };
  setState({ commentDraft: { path: s.path, targets: meta.targets ?? [], scene, editing: note.id, text: original, resolved: meta.status === "resolved" } });
}

export function commitComment(text: string) {
  const d = getState().commentDraft;
  setState({ commentDraft: null });
  const s = d ? sessions.get(d.path) : undefined;
  if (!d || !s?.api || !text.trim()) return;
  if (d.editing) return saveEdit(s, d.editing, text.trim());
  const byId = new Map((s.snapshot().elements as El[]).filter((e) => !e.isDeleted).map((e) => [e.id, e]));
  const noteId = randomId();
  const gid = randomId();
  const sk: any[] = [
    {
      type: "rectangle", id: noteId, x: d.scene.x, y: d.scene.y, width: 240, height: 56,
      backgroundColor: NOTE.bg, strokeColor: NOTE.stroke, fillStyle: "solid", strokeWidth: 1, roughness: 0, roundness: { type: 3 },
      label: { text: text.trim(), fontSize: 16, textAlign: "left", verticalAlign: "top", strokeColor: NOTE.text },
    },
  ];
  const box = unionBox(d.targets.map((id) => byId.get(id)).filter(Boolean) as El[]);
  if (box) {
    const sy = d.scene.y + 24;
    const ey = Math.min(Math.max(sy, box.y + 8), box.y + box.h - 8);
    const sx = d.scene.x - 4, ex = box.x + box.w + 6;
    sk.push({ type: "arrow", x: sx, y: sy, points: [[0, 0], [ex - sx, ey - sy]], strokeColor: NOTE.stroke, strokeStyle: "dashed", strokeWidth: 1, roughness: 0, startArrowhead: null, endArrowhead: "circle" });
  }
  const made = (convertToExcalidrawElements(sk, { regenerateIds: false }) as unknown as El[]).map((e) => ({
    ...e,
    groupIds: [gid],
    customData: { excalidesk: e.id === noteId ? { comment: { targets: d.targets, status: "open", author: "user", at: Date.now() } } : { commentOf: noteId } },
  }));
  s.applyUser(made);
}

/**
 * 改批注的文字：便签按新文字重新排版（高度跟着文字，不小于新建时的 56）。
 * 已处理的批注改了文字 = 有新要求：重新打开（去掉 Agent 的回复，恢复黄色），Agent 下次 get_feedback 会看到它（edited）。
 * 文字没变就什么都不做（已处理的也不重新打开）。
 */
function saveEdit(s: DocSession, noteId: string, value: string) {
  const els = s.snapshot().elements as El[];
  const note = els.find((e) => e.id === noteId);
  if (!note || note.isDeleted || !isComment(note)) return;
  const { text, arrow, original } = noteParts(els, note);
  if (value === original) return;
  const meta = ext(note)!.comment;
  const reopen = meta.status === "resolved";
  const { reply: _r, resolvedBy: _b, resolvedAt: _a, ...rest } = meta;
  const comment = reopen ? { ...rest, status: "open", editedAt: Date.now() } : { ...meta, editedAt: Date.now() };
  const n1 = bump(note, {
    height: 56,
    ...(reopen ? { backgroundColor: NOTE.bg, strokeColor: NOTE.stroke, opacity: 100 } : {}),
    customData: { ...note.customData, excalidesk: { ...ext(note), comment } },
  });
  const r = layoutLabel(n1, text, value);
  const patch: El[] = [r.container];
  // 便签原来没有文字（别处删掉了）：新配的文字也标成这条批注的一部分
  const t1 = r.text && !text ? { ...r.text, customData: { excalidesk: { commentOf: note.id } } } : r.text;
  if (t1) patch.push(reopen ? { ...t1, strokeColor: NOTE.text, opacity: 100 } : t1);
  if (reopen && arrow) patch.push(bump(arrow, { strokeColor: NOTE.stroke, opacity: 100 }));
  s.applyUser(patch);
}

/** 依次跳到未处理的批注：展开时选中它；收起时打开它的输入框（便签藏着，选中了也看不见） */
const cursor = new Map<string, number>();
export function nextComment(path: string) {
  const s = sessions.get(path);
  if (!s?.api) return;
  const els = s.snapshot().elements as El[];
  const notes = els.filter(isOpenComment).sort((a, b) => a.y - b.y || a.x - b.x);
  if (!notes.length) return;
  const i = ((cursor.get(path) ?? -1) + 1) % notes.length;
  cursor.set(path, i);
  const note = notes[i];
  if (getState().notesFolded) {
    const { arrow } = noteParts(els, note);
    s.api.scrollToContent(arrow ?? note, { animate: true, fitToViewport: false });
    editComment(s, note.id);
    return;
  }
  s.api.scrollToContent(note, { animate: true, fitToViewport: false });
  s.api.updateScene({ appState: { selectedElementIds: { [note.id]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
}

/** 「发回给 Agent」：不会自动发送，只有用户点了才发 */
export async function sendToAgent(path: string) {
  const s = sessions.get(path);
  if (s) await s.flush();
  try {
    const r = await ipc.mcpSend(path);
    const sep = getState().lang === "zh" ? "、" : ", ";
    if (r.woke.length) toast(t("agent.sentWoke", { names: r.woke.join(sep) }));
    else if (r.pushed.length) toast(t("agent.sentPushed", { names: r.pushed.join(sep) }));
    else toast(t("agent.sentQueued"));
  } catch (e) {
    toast(String(e));
  }
}
