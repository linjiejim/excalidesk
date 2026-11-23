// 转换形状的界面（docs/specs/20261123-convert-shapes.md）：浮层、Actions 栏里的按钮、Tab / ⇧ 快捷键。
// 转换本身在 convert.ts。浮层和按钮都 portal 进 Excalidraw 的 DOM，好用它的主题变量和按钮样式。
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CaptureUpdateAction, getCommonBounds } from "@excalidraw/excalidraw";
import { TARGETS, TARGET_KEYS, changes, convert, currentOf, cycleOf, lift, merge, revert, styleOf, unitsOf, type Style, type Target, type Unit } from "./convert";
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
  /** 我们自己设的选择：onChange 里看到它不算「用户换了选择」 */
  expect: string;
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

function begin(s: DocSession, mode: Round["mode"], anchor: HTMLElement | null = null): Round | null {
  const api = s.api;
  if (!api) return null;
  const units = unitsNow(s);
  if (!units.length) return null;
  const order = cycleOf(units);
  const cur = currentOf(units);
  const st = api.getAppState();
  const selected = selMap(Object.keys(st.selectedElementIds ?? {}).filter((id) => st.selectedElementIds[id]));
  return {
    session: s, mode, units, anchor, order, ids: new Map(), touched: new Set(),
    original: (api.getSceneElementsIncludingDeleted() as El[]).map((e) => ({ ...e })),
    selected, idx: cur ? order.indexOf(cur) : -1, style: styleOf(st), expect: selKey(Object.keys(selected)),
  };
}

/** 循环里的一步：从原样算出结果，不进撤销记录（NEVER），收起时再一次性记一步 */
function step(r: Round, dir: 1 | -1) {
  const api = r.session.api;
  if (!api || !r.order.length) return;
  const n = r.order.length;
  r.idx = r.idx < 0 ? (dir > 0 ? 0 : n - 1) : (r.idx + dir + n) % n;
  const target = r.order[r.idx];
  const scene = api.getSceneElementsIncludingDeleted() as El[];
  const res = convert(r.original, r.units, target, r.style, r.ids);
  const now = new Set(res.changed.map((e) => e.id));
  const back = revert([...r.touched].filter((id) => !now.has(id)), r.original, scene);
  const next = merge(scene, lift([...back, ...res.changed], scene), res.below);
  now.forEach((id) => r.touched.add(id));
  const select = res.select.length ? res.select : Object.keys(r.selected);
  r.expect = selKey(select);
  r.session.userInput();
  api.updateScene({ elements: next, appState: { selectedElementIds: selMap(select) }, captureUpdate: CaptureUpdateAction.NEVER });
  notify();
}

/** 收起：恢复成原样（NEVER），再写入最终结果（IMMEDIATELY）——一整轮只占一步撤销 */
function finish(target: Target | null) {
  const r = round;
  if (!r) return;
  round = null;
  notify();
  const api = r.session.api;
  if (!api) return;
  r.session.userInput();
  let scene = api.getSceneElementsIncludingDeleted() as El[];
  const final = target && r.units.some((u) => changes(u, target)) ? convert(r.original, r.units, target, r.style, r.ids) : null;
  if (r.touched.size) {
    scene = merge(scene, revert(r.touched, r.original, scene));
    api.updateScene({ elements: scene, appState: { selectedElementIds: r.selected }, captureUpdate: CaptureUpdateAction.NEVER });
  }
  if (final) {
    api.updateScene({ elements: merge(scene, lift(final.changed, scene), final.below), appState: { selectedElementIds: selMap(final.select) }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
}

/** 直接转换（⇧R 等）：一次转换一步撤销。没有可转换的、或者都已经是这个类型，返回 false */
export function convertSelection(s: DocSession, target: Target): boolean {
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

function open(r: Round | null) {
  if (round) finish(liveTarget(round));
  round = r;
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
  if (!api || api.getAppState().editingTextElement) return false;
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
    open(r);
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
  const sel = appState.selectedElementIds;
  if (sel === lastSel) return;
  lastSel = sel;
  const r = round;
  if (r && r.session === s && selKey(Object.keys(sel ?? {}).filter((id) => sel[id])) !== r.expect) queueMicrotask(() => round === r && finish(liveTarget(r)));
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
  const [pos, setPosRaw] = useState<{ left: number; top: number } | null>(null);
  const setPos = (p: { left: number; top: number } | null) => setPosRaw((old) => (old?.left === p?.left && old?.top === p?.top ? old : p));
  const api = session.api;
  const mine = r && r.session === session ? r : null;

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
    if (!mine || !root || !api) return setPos(null);
    const box = root.getBoundingClientRect();
    const w = popup.current?.offsetWidth ?? 160, h = popup.current?.offsetHeight ?? 44;
    let left: number, top: number;
    if (mine.mode === "button" && mine.anchor?.isConnected) {
      const b = mine.anchor.getBoundingClientRect();
      left = b.right - box.left + 8;
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
            onClick={(e) => (mine?.mode === "button" ? finish(null) : open(begin(session, "button", e.currentTarget)))}
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
