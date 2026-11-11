// Agent（MCP）在前端的一半：Rust 发来 mcp-call，这里执行，再用 mcp_reply 回答。
// 需要 Excalidraw 本身的事都在这里：简化元素 → 真实元素、Mermaid、渲染 PNG、放进画布（可撤销、正常保存）。
// 同一张图的写操作排队执行；不同的图互不等待，所以多个 Agent 可以同时改各自的图，图不必在当前标签。
import { CaptureUpdateAction, convertToExcalidrawElements, exportToBlob, restoreElements } from "@excalidraw/excalidraw";
import { activate, openPath, sessions } from "./actions";
import {
  bump, boundTextOf, boxOf, commentOf, ext, isComment, isCommentLike, isOpenComment, layoutLabel, randomId, relayoutText, REPLY_SEP, route, stamp, unionBox,
  type Box, type El,
} from "./elements";
import { t } from "./i18n";
import { inTauri, ipc } from "./ipc";
import type { DocSession } from "./session";
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

type DrawArgs = { path: string; agent: string; elements: any[]; frame?: string; at?: { x: number; y: number }; style?: string };

async function draw(a: DrawArgs) {
  if (!Array.isArray(a.elements) || !a.elements.length) throw new Error("`elements` is empty");
  const s = await ensureSession(a.path);
  await begin(s);
  // 从这里到 applyAgent 都是同步的：读到的画布就是放进去那一刻的画布
  const { elements: cur } = snap(s);
  const byId = new Map(cur.map((e) => [e.id, e]));
  const batch = new Set<string>();
  for (const e of a.elements) {
    if (!e || typeof e !== "object" || typeof e.type !== "string") throw new Error("every element needs a `type`");
    if (e.id != null) {
      if (byId.has(e.id)) throw new Error(`id "${e.id}" is already used in this drawing; pick another id, or use update_elements to change it`);
      if (batch.has(e.id)) throw new Error(`id "${e.id}" appears twice`);
      batch.add(e.id);
    }
  }
  const frameEl = a.frame ? findFrame(cur, a.frame) : undefined;
  const o = origin(cur, a.at, frameEl);
  const sk: any[] = styled(
    a.elements.map((e) => ({ ...structuredClone(e), id: e.id ?? randomId(), x: (Number(e.x) || 0) + o.x, y: (Number(e.y) || 0) + o.y })),
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
  const placed = frameUp([...out.values()], a.frame, frameEl);
  for (const e of placed.changed) existing.set(e.id, e);
  const created = placed.newEls.map((e) => stamp(e, a.agent));
  await s.applyAgent([...existing.values(), ...created], {}, a.agent);
  banner(s, a.agent, t("agent.drew", { n: shapeCount(created) }));
  const box = unionBox(created)!;
  return {
    ids: [...created.map((e) => e.id), ...existing.keys()],
    created: created.filter((e) => !(e.type === "text" && e.containerId)).map((e) => e.id),
    frame: placed.frameId,
    bounds: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) },
  };
}

async function mermaid(a: { path: string; agent: string; mermaid: string; frame?: string; at?: { x: number; y: number }; style?: string }) {
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
  const o = origin(cur, a.at, frameEl);
  const b = unionBox(conv)!;
  const moved = conv.map((e) => ({ ...e, x: e.x - b.x + o.x, y: e.y - b.y + o.y }));
  const placed = frameUp(moved, a.frame, frameEl);
  const existing = new Map(placed.changed.map((e) => [e.id, e]));
  const created = placed.newEls.map((e) => stamp(e, a.agent));
  await s.applyAgent([...existing.values(), ...created], (parsed.files ?? {}) as Files, a.agent);
  banner(s, a.agent, t("agent.drew", { n: shapeCount(created) }));
  const box = unionBox(created)!;
  return {
    ids: [...created.map((e) => e.id), ...existing.keys()],
    created: created.filter((e) => !(e.type === "text" && e.containerId)).map((e) => e.id),
    frame: placed.frameId,
    bounds: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) },
  };
}

const STYLE_KEYS = ["strokeColor", "backgroundColor", "fillStyle", "strokeStyle", "strokeWidth", "roughness", "opacity", "link", "locked"];

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
  for (const u of a.updates) {
    let el = u?.id ? get(u.id) : undefined;
    if (!el || el.isDeleted) {
      missing.push(String(u?.id));
      continue;
    }
    if (isCommentLike(el)) throw new Error(`"${u.id}" is part of the user's comment; use resolve_comments instead`);
    // 改容器里的文字 = 改容器的标签
    if (el.type === "text" && el.containerId && get(el.containerId)) el = get(el.containerId)!;
    const patch: Record<string, any> = {};
    for (const k of STYLE_KEYS) if (k in u) patch[k] = u[k];
    if ("name" in u && isFrame(el)) patch.name = u.name;
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
    await s.applyAgent([...changed.values()], {}, a.agent);
    banner(s, a.agent, t("agent.changed", { n: a.updates.length - missing.length }));
  }
  return { ids: [...changed.keys()], updated: a.updates.map((u) => u?.id).filter((id) => id && !missing.includes(id)), missing };
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

/** 按 C：给选中的元素（没选就是画布中间）开一个批注输入框 */
export function startComment(s: DocSession) {
  const api = s.api;
  if (!api) return;
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
  const left = (scene.x + st.scrollX) * zoom + st.offsetLeft;
  const top = (scene.y + st.scrollY) * zoom + st.offsetTop;
  setState({ commentDraft: { path: s.path, left, top, targets, scene } });
}

export function commitComment(text: string) {
  const d = getState().commentDraft;
  setState({ commentDraft: null });
  const s = d ? sessions.get(d.path) : undefined;
  if (!d || !s?.api || !text.trim()) return;
  const api = s.api;
  const byId = new Map((api.getSceneElements() as El[]).map((e) => [e.id, e]));
  const noteId = randomId();
  const gid = randomId();
  const sk: any[] = [
    {
      type: "rectangle", id: noteId, x: d.scene.x, y: d.scene.y, width: 240, height: 56,
      backgroundColor: "#ffec99", strokeColor: "#f08c00", fillStyle: "solid", strokeWidth: 1, roughness: 0, roundness: { type: 3 },
      label: { text: text.trim(), fontSize: 16, textAlign: "left", verticalAlign: "top", strokeColor: "#1e1e1e" },
    },
  ];
  const box = unionBox(d.targets.map((id) => byId.get(id)).filter(Boolean) as El[]);
  if (box) {
    const sy = d.scene.y + 24;
    const ey = Math.min(Math.max(sy, box.y + 8), box.y + box.h - 8);
    const sx = d.scene.x - 4, ex = box.x + box.w + 6;
    sk.push({ type: "arrow", x: sx, y: sy, points: [[0, 0], [ex - sx, ey - sy]], strokeColor: "#f08c00", strokeStyle: "dashed", strokeWidth: 1, roughness: 0, startArrowhead: null, endArrowhead: "circle" });
  }
  const made = (convertToExcalidrawElements(sk, { regenerateIds: false }) as unknown as El[]).map((e) => ({
    ...e,
    groupIds: [gid],
    customData: { excalidesk: e.id === noteId ? { comment: { targets: d.targets, status: "open", author: "user", at: Date.now() } } : { commentOf: noteId } },
  }));
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...made], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

/** 依次跳到未处理的批注 */
const cursor = new Map<string, number>();
export function nextComment(path: string) {
  const s = sessions.get(path);
  if (!s?.api) return;
  const notes = (s.api.getSceneElements() as El[]).filter(isOpenComment).sort((a, b) => a.y - b.y || a.x - b.x);
  if (!notes.length) return;
  const i = ((cursor.get(path) ?? -1) + 1) % notes.length;
  cursor.set(path, i);
  s.api.scrollToContent(notes[i], { animate: true, fitToViewport: false });
  s.api.updateScene({ appState: { selectedElementIds: { [notes[i].id]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
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
