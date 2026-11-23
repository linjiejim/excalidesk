// 转换形状的界面（docs/specs/20261123-convert-shapes.md）：浮层、Actions 栏里的按钮、Tab / ⇧ 快捷键。
// 转换本身在 convert.ts。浮层和按钮都 portal 进 Excalidraw 的 DOM，好用它的主题变量和按钮样式。
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CaptureUpdateAction, getCommonBounds } from "@excalidraw/excalidraw";
import { TARGETS, TARGET_KEYS, changes, convert, currentOf, cycleOf, lift, merge, revert, styleOf, unitsOf, unlinked, type Style, type Target, type Unit } from "./convert";
import type { El } from "./elements";
import { t } from "./i18n";
import type { DocSession } from "./session";

// ── 一次打开的浮层 = 一轮转换 ───────────────────────────

type Round = {
  session: DocSession;
  mode: "tab" | "button";
  units: Unit[];
  /** 这一轮开始前的场景（浅拷贝）和选择：每一步都从这里算，收起时也从这里恢复 */
  original: El[];
  selected: Record<string, true>;
  order: Target[];
  /** order 里当前停在哪一项；-1 = 还没动（混合选择时没有当前类型） */
  idx: number;
  ids: Map<string, string>;
  style: Style;
  /** 循环中改过的元素 id，收起时要恢复它们 */
  touched: Set<string>;
  /** 选中了、但转换不了的元素（箭头、图片……）：转换后照样选着 */
  keep: string[];
  /** 我们自己设的选择：onChange 里看到它不算「用户换了选择」 */
  expect: string;
  /** 这一轮关心的元素（单元、里面的文字、连着的箭头、改过的）最后一次写下去时的版本号。
   *  对不上 = 别人（Agent、外部修改、历史恢复）改过，这一轮作废，不再拿 original 覆盖它们 */
  written: Map<string, string>;
  anchor: HTMLElement | null;
};

let round: Round | null = null;
/** 浮层或选择变了就加一，组件靠它重新渲染 */
let tick = 0;
const subs = new Set<() => void>();
const notify = () => {
  tick++;
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

const selKey = (ids: Iterable<string>) => [...ids].sort().join(",");
const selMap = (ids: Iterable<string>) => Object.fromEntries([...ids].map((id) => [id, true as const]));
const liveTarget = (r: Round) => (r.idx >= 0 ? r.order[r.idx] : null);

function unitsNow(s: DocSession): Unit[] {
  const api = s.api;
  if (!api) return [];
  return unitsOf(api.getSceneElementsIncludingDeleted() as El[], api.getAppState().selectedElementIds ?? {});
}

const sceneOf = (r: Round) => (r.session.api?.getSceneElementsIncludingDeleted() ?? []) as El[];
const selectedIds = (st: Record<string, any>) => Object.keys(st.selectedElementIds ?? {}).filter((id) => st.selectedElementIds[id]);

/** 版本号 + nonce：合并时版本相同按 nonce 定胜负，只比版本号会漏掉另一台 Mac 恰好同版本的修改 */
const stamp = (e: El) => `${e.version}:${e.versionNonce}`;

/** 写完之后记下这一轮可能改到的元素（单元、里面的文字、连着的箭头、指着它们的批注、改过的）的版本；写之后再读：syncInvalidIndices 会原地抬高新元素的版本 */
function record(r: Round) {
  const ids = new Set(r.touched);
  for (const u of r.units) {
    for (const e of [u.el, u.text]) {
      if (!e) continue;
      ids.add(e.id);
      for (const b of e.boundElements ?? []) if (b.type === "arrow") ids.add(b.id);
    }
  }
  const units = new Set(r.units.map((u) => u.el.id));
  const scene = sceneOf(r);
  for (const e of scene) {
    const targets = e.customData?.excalidesk?.comment?.targets;
    if (Array.isArray(targets) && targets.some((t: string) => units.has(t))) ids.add(e.id);
  }
  r.written = new Map(scene.filter((e) => ids.has(e.id)).map((e) => [e.id, stamp(e)]));
}

/** 这一轮关心的元素被别人改过了吗 */
function stale(r: Round) {
  if (!r.session.api) return true;
  let seen = 0;
  for (const e of sceneOf(r)) {
    const v = r.written.get(e.id);
    if (v === undefined) continue;
    if (v !== stamp(e)) return true;
    seen++;
  }
  return seen !== r.written.size;
}

/** 别人改过：这一轮作废，场景保持现在的样子（别人的修改胜出），循环中的中间状态不进撤销记录 */
function drop(r: Round) {
  if (round !== r) return;
  round = null;
  notify();
}

function begin(s: DocSession, mode: Round["mode"], anchor: HTMLElement | null = null): Round | null {
  const api = s.api;
  if (!api) return null;
  const units = unitsNow(s);
  if (!units.length) return null;
  const order = cycleOf(units);
  const cur = currentOf(units);
  const st = api.getAppState();
  const ids = selectedIds(st);
  const own = new Set(units.flatMap((u) => [u.el.id, u.text?.id ?? ""]));
  const r: Round = {
    session: s, mode, units, anchor, order, ids: new Map(), touched: new Set(),
    original: (api.getSceneElementsIncludingDeleted() as El[]).map((e) => ({ ...e })),
    selected: selMap(ids), keep: ids.filter((id) => !own.has(id)), written: new Map(),
    idx: cur ? order.indexOf(cur) : -1, style: styleOf(st), expect: selKey(ids),
  };
  record(r);
  return r;
}

/** 选择还是我们设的那套吗（别人换了选择，比如新建一页、开始放映，就别再改回去） */
const ownsSelection = (r: Round) => {
  const st = r.session.api?.getAppState();
  return !!st && r.expect.split(",").every((id) => !id || st.selectedElementIds?.[id]);
};

/** 循环里的一步：从原样算出结果，不进撤销记录（NEVER），收起时再一次性记一步 */
function step(r: Round, dir: 1 | -1) {
  const api = r.session.api;
  if (!api || !r.order.length) return;
  if (stale(r)) return drop(r);
  const n = r.order.length;
  r.idx = r.idx < 0 ? (dir > 0 ? 0 : n - 1) : (r.idx + dir + n) % n;
  const target = r.order[r.idx];
  const scene = api.getSceneElementsIncludingDeleted() as El[];
  const res = convert(r.original, r.units, target, r.style, r.ids);
  const now = new Set(res.changed.map((e) => e.id));
  const back = revert([...r.touched].filter((id) => !now.has(id)), r.original, scene);
  const next = merge(scene, lift([...back, ...res.changed], scene), res.below);
  now.forEach((id) => r.touched.add(id));
  const select = [...r.keep, ...res.select];
  r.expect = selKey(select);
  r.session.userInput();
  api.updateScene({ elements: next, appState: { selectedElementIds: selMap(select) }, captureUpdate: CaptureUpdateAction.NEVER });
  record(r);
  notify();
}

/**
 * 收起：恢复成原样（NEVER），再写入最终结果（IMMEDIATELY）——一整轮只占一步撤销。
 * 新建的容器在恢复这一步里先以「已删除、不连任何东西」放进场景：撤销时它回到这个样子，
 * 不会留下一个已删除、却还登记着文字的容器（重新打开时 restoreElements 会把文字绑回去）
 */
function finish(target: Target | null) {
  const r = round;
  if (!r) return;
  if (stale(r)) return drop(r);
  round = null;
  notify();
  const api = r.session.api;
  if (!api) return;
  r.session.userInput();
  const own = ownsSelection(r);
  let scene = api.getSceneElementsIncludingDeleted() as El[];
  const final = target && r.units.some((u) => changes(u, target)) ? convert(r.original, r.units, target, r.style, r.ids) : null;
  const back = revert(r.touched, r.original, scene);
  const placed = new Set([...scene.map((e) => e.id), ...back.map((e) => e.id)]);
  const holders = (final?.changed ?? []).filter((e) => !placed.has(e.id)).map(unlinked);
  if (back.length || holders.length) {
    scene = merge(scene, [...back, ...holders], final?.below);
    api.updateScene({ elements: scene, ...(own && { appState: { selectedElementIds: r.selected } }), captureUpdate: CaptureUpdateAction.NEVER });
    scene = api.getSceneElementsIncludingDeleted() as El[];
  }
  if (final) {
    const select = selMap([...r.keep, ...final.select]);
    api.updateScene({ elements: merge(scene, lift(final.changed, scene), final.below), ...(own && { appState: { selectedElementIds: select } }), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
}

/** 直接转换（⇧R 等）：一次转换一步撤销。没有可转换的、或者都已经是这个类型，返回 false */
function convertSelection(s: DocSession, target: Target): boolean {
  if (round) {
    finish(target);
    return true;
  }
  const r = begin(s, "button");
  if (!r || !r.units.some((u) => changes(u, target))) return false;
  round = r;
  finish(target);
  return true;
}

/** 打开新的一轮：先把开着的那一轮收起（写完），再从收起后的场景开始，否则新一轮的快照和版本号马上就过期 */
function open(make: () => Round | null) {
  if (round) finish(liveTarget(round));
  round = make();
  notify();
}

/**
 * 画布上的按键（Editor 的 onKeyDownCapture 先交给这里）。处理了返回 true，调用方就不再往下传。
 * 正在编辑文字、焦点在输入框里、输入法组字、放映中都不管。
 */
export function convertKey(s: DocSession, e: React.KeyboardEvent, presenting: boolean): boolean {
  if (presenting || e.nativeEvent.isComposing) return false;
  if ((e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable='true']")) return false;
  const api = s.api;
  const st = api?.getAppState();
  if (!st || st.editingTextElement || st.viewModeEnabled) return false;
  const mod = e.metaKey || e.ctrlKey || e.altKey;
  const stop = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (round) {
    if (e.key === "Tab" && !mod) {
      stop();
      step(round, e.shiftKey ? -1 : 1);
      return true;
    }
    if (e.key === "Escape" || e.key === "Enter") {
      stop();
      finish(liveTarget(round));
      return true;
    }
    if (["Shift", "Meta", "Control", "Alt", "CapsLock"].includes(e.key)) return false;
    if (e.shiftKey && !mod && TARGET_KEYS[e.code]) {
      stop();
      finish(TARGET_KEYS[e.code]);
      return true;
    }
    // 其他键：先收起（记下这一步撤销），再照常交给 Excalidraw，比如 ⌘Z 就撤销这次转换
    finish(liveTarget(round));
    return false;
  }
  // 和上游一样：焦点在画布上（或者没有焦点）才拦 Tab；焦点在属性面板的按钮上时，Tab 照常移动焦点
  const focus = document.activeElement as HTMLElement | null;
  const onCanvas = !focus || focus === document.body || focus.classList.contains("excalidraw") || focus.tagName === "CANVAS" || !!focus.closest(".xd-convert-trigger");
  if (e.key === "Tab" && !mod && onCanvas) {
    const r = begin(s, "tab");
    if (!r) return false;
    stop();
    open(() => r);
    return true;
  }
  if (e.shiftKey && !mod && !e.repeat && TARGET_KEYS[e.code]) {
    if (!convertSelection(s, TARGET_KEYS[e.code])) return false;
    stop();
    return true;
  }
  return false;
}

// ── 图标（tabler 风格，和 Excalidraw 的工具栏一样是 1.5 的描边） ──

const svg = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const ICONS: Record<Target, React.ReactNode> = {
  rectangle: svg(<rect x="4" y="4" width="16" height="16" rx="2" />),
  diamond: svg(<path d="M10.5 20.4l-6.9-6.9c-.8-.8-.8-2.2 0-3l6.9-6.9c.8-.8 2.2-.8 3 0l6.9 6.9c.8.8.8 2.2 0 3l-6.9 6.9c-.8.8-2.2.8-3 0z" />),
  ellipse: svg(<circle cx="12" cy="12" r="9" />),
  text: svg(<><path d="M6 5h12" /><path d="M12 5v14" /></>),
};
const TRIGGER_ICON = svg(<><rect x="3" y="3" width="8" height="8" rx="1.5" /><circle cx="17" cy="17" r="4" /><path d="M14 4h3a3 3 0 0 1 3 3v2" /><path d="M18 7.5l2 1.5 1.5-2" /><path d="M10 20H7a3 3 0 0 1-3-3v-2" /><path d="M6 16.5l-2-1.5-1.5 2" /></>);
const KEYS: Record<Target, string> = { rectangle: "⇧R", diamond: "⇧D", ellipse: "⇧O", text: "⇧T" };

// ── 组件 ────────────────────────────────────────────────

/** Excalidraw 属性面板里「操作 / Actions」那一组按钮（0.18.1 写死的，没有扩展口，只能按标题找） */
const ACTIONS_LEGENDS = new Set(["操作", "Actions"]);
function findActionsList(host: HTMLElement): HTMLElement | null {
  for (const f of host.querySelectorAll<HTMLElement>(".selected-shape-actions fieldset")) {
    if (ACTIONS_LEGENDS.has(f.querySelector("legend")?.textContent?.trim() ?? "")) return f.querySelector<HTMLElement>(".buttonList");
  }
  return null;
}

/** Actions 栏末尾的槽：Excalidraw 重新渲染这一栏时会丢掉它，MutationObserver 再插回去 */
function useActionsSlot(host: HTMLElement | null) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!host) return;
    let cur: HTMLElement | null = null;
    const sync = () => {
      const list = findActionsList(host);
      if (!list) {
        if (cur) setSlot((cur = null));
        return;
      }
      if (!cur || !list.contains(cur)) {
        cur = document.createElement("span");
        cur.className = "xd-convert-slot";
        list.appendChild(cur);
        setSlot(cur);
      } else if (list.lastElementChild !== cur) list.appendChild(cur);
    };
    const mo = new MutationObserver(sync);
    mo.observe(host, { childList: true, subtree: true });
    sync();
    return () => {
      mo.disconnect();
      cur?.remove();
    };
  }, [host]);
  return slot;
}

/**
 * Editor 的 onChange / onScrollChange 顺手调这里：选择变了（不是我们自己设的）就收起浮层；
 * 让按钮知道现在能不能转换；浮层跟着镜头走。
 */
let lastSel: unknown = null;
export function onConvertChange(s: DocSession, appState: Record<string, any>) {
  const r = round;
  // 浮层开着时别人改了这一轮的元素（Agent、外部修改、历史恢复）：作废，不拿开始前的快照覆盖回去
  if (r && r.session === s && stale(r)) return drop(r);
  const sel = appState.selectedElementIds;
  if (sel === lastSel) return;
  lastSel = sel;
  // 只看我们选中的那些还在不在：在分组里转换时 Excalidraw 会把选择扩到组里其他元素，那不算用户换了选择
  if (r && r.session === s && r.expect.split(",").some((id) => id && !sel?.[id])) queueMicrotask(() => round === r && finish(liveTarget(r)));
  notify();
}
export function onConvertScroll() {
  if (round) notify();
}

export function ConvertLayer({ session, host, presenting }: { session: DocSession; host: HTMLElement | null; presenting: boolean }) {
  useSyncExternalStore(subscribe, () => tick);
  const r = round;
  const slot = useActionsSlot(host);
  const popup = useRef<HTMLDivElement>(null);
  const api = session.api;
  const mine = r && r.session === session ? r : null;
  // 位置记在这一轮上：浮层关着时不用算，也不 setState
  const [placed, setPlaced] = useState<{ round: Round; left: number; top: number } | null>(null);
  const pos = placed && placed.round === mine ? placed : null;
  const setPos = (p: { left: number; top: number } | null) =>
    setPlaced((old) => (!p || !mine ? null : old && old.round === mine && old.left === p.left && old.top === p.top ? old : { round: mine, ...p }));

  // 换标签（Editor 重新挂载）或进放映时收起
  useEffect(() => () => void (round?.session === session && finish(liveTarget(round))), [session]);
  useEffect(() => {
    if (presenting && round) finish(liveTarget(round));
  }, [presenting]);

  // 点浮层外面：收起
  useEffect(() => {
    if (!mine) return;
    const down = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      if (popup.current?.contains(el) || el.closest?.(".xd-convert-trigger")) return;
      if (round) finish(liveTarget(round));
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [mine]);

  const root = host?.querySelector<HTMLElement>(".excalidraw") ?? null;
  // 浮层位置：Tab 打开的在选区左下方（和上游一样），按钮打开的在按钮右边
  useLayoutEffect(() => {
    if (!mine || !root || !api) return;
    const box = root.getBoundingClientRect();
    const w = popup.current?.offsetWidth ?? 160, h = popup.current?.offsetHeight ?? 44;
    let left: number, top: number;
    if (mine.mode === "button" && mine.anchor?.isConnected) {
      // 贴着属性面板的右边弹出：Actions 那一排按钮会换行，按钮不一定在面板最右边，浮层不能盖住面板
      const b = mine.anchor.getBoundingClientRect();
      const panel = mine.anchor.closest<HTMLElement>(".App-menu__left, .selected-shape-actions")?.getBoundingClientRect();
      left = Math.max(b.right, panel?.right ?? 0) - box.left + 8;
      top = b.top - box.top + (b.height - h) / 2;
    } else {
      const st = api.getAppState();
      const sel = (api.getSceneElements() as El[]).filter((e) => st.selectedElementIds[e.id]);
      if (!sel.length) return setPos(null);
      const [x1, y1, , y2] = getCommonBounds(sel as any);
      const z = st.zoom.value;
      left = (x1 + st.scrollX) * z;
      top = (y2 + st.scrollY) * z + 10;
      if (top + h > box.height - 8) top = (y1 + st.scrollY) * z - h - 10;
    }
    setPos({ left: Math.max(8, Math.min(left, box.width - w - 8)), top: Math.max(8, Math.min(top, box.height - h - 8)) });
  });

  const units = api && !presenting ? unitsNow(session) : [];
  const trigger =
    slot && units.length
      ? createPortal(
          <button
            type="button"
            className={`ToolIcon_type_button ToolIcon_size_medium ToolIcon_type_button--show ToolIcon xd-convert-trigger${mine?.mode === "button" ? " ToolIcon--selected" : ""}`}
            title={t("convert.trigger")}
            aria-label={t("convert.title")}
            aria-expanded={mine?.mode === "button"}
            onClick={(e) => {
              const btn = e.currentTarget;
              if (mine?.mode === "button") finish(liveTarget(mine));
              else open(() => begin(session, "button", btn));
            }}
          >
            <div className="ToolIcon__icon" aria-hidden="true">{TRIGGER_ICON}</div>
          </button>,
          slot,
        )
      : null;

  const live = mine ? (mine.idx >= 0 ? mine.order[mine.idx] : null) : null;
  const panel =
    mine && root
      ? createPortal(
          <div ref={popup} className="xd-convert" role="toolbar" aria-label={t("convert.title")} style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}>
            {TARGETS.map((tg) => {
              const enabled = mine.order.includes(tg);
              return (
                <button
                  key={tg}
                  type="button"
                  data-target={tg}
                  className="xd-convert__item"
                  title={`${t(`convert.${tg}`)} — ${KEYS[tg]}`}
                  aria-label={t(`convert.${tg}`)}
                  aria-pressed={live === tg}
                  disabled={!enabled}
                  onClick={() => finish(tg)}
                >
                  {ICONS[tg]}
                </button>
              );
            })}
          </div>,
          root,
        )
      : null;

  return (
    <>
      {trigger}
      {panel}
    </>
  );
}
