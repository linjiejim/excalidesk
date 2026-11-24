// 收起批注（docs/specs/20261124-fold-notes.md）：开关（⇧C）、收起后画布上的小圆点、挡住会改到藏起来的批注的点击。
// 批注在画布上怎么藏、存盘和 Agent 读写时怎么还原，见 elements.ts（fold / unfold）和 session.ts。
import { useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getCommonBounds } from "@excalidraw/excalidraw";
import { sessions } from "./actions";
import { editComment } from "./agent";
import { boundTextOf, commentOf, ext, isComment, isCommentLike, isFolded, noteIdOf, pinPoint, REPLY_SEP, type El } from "./elements";
import { t } from "./i18n";
import type { DocSession } from "./session";
import { getState, setState, useShell } from "./store";

// ── 开关 ───────────────────────────────────────────────

/** 收起 / 展开所有标签的批注。只改画布上的样子，不写文件、不进撤销 */
export function toggleNotes(folded = !getState().notesFolded) {
  localStorage.setItem("notesFolded", folded ? "1" : "0");
  setState({ notesFolded: folded });
  for (const s of sessions.values()) s.applyNoteView();
  notify();
}

// ── 镜头和场景的变化：小圆点和批注输入框跟着走 ──────────

let tick = 0;
const subs = new Set<() => void>();
function notify() {
  tick++;
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
/** 订阅镜头 / 场景变化（批注输入框用它跟着画布走） */
export const useViewTick = () => useSyncExternalStore(subscribe, () => tick);

/** Editor 的 onChange 顺手调：只在场景数组或镜头真的变了时通知（onChange 连鼠标悬停都会触发） */
let last: { els: unknown; x: number; y: number; z: number; w: number; h: number } | null = null;
export function onNotesChange(elements: unknown, st: Record<string, any>) {
  const cur = { els: elements, x: st.scrollX, y: st.scrollY, z: st.zoom?.value, w: st.width, h: st.height };
  if (last && last.els === cur.els && last.x === cur.x && last.y === cur.y && last.z === cur.z && last.w === cur.w && last.h === cur.h) return;
  last = cur;
  notify();
}

// ── 小圆点 ─────────────────────────────────────────────

type Pin = { id: string; x: number; y: number; text: string; resolved: boolean };

function pinsOf(els: readonly El[]): Pin[] {
  const arrows = new Map<string, El>();
  for (const e of els) if (!e.isDeleted && e.type === "arrow" && commentOf(e)) arrows.set(commentOf(e)!, e);
  const byId = new Map(els.map((e) => [e.id, e]));
  const pins: Pin[] = [];
  for (const e of els) {
    if (e.isDeleted || !isComment(e)) continue;
    const label = boundTextOf(e, byId);
    const text = String(label?.originalText ?? label?.text ?? "").split(REPLY_SEP)[0];
    pins.push({ id: e.id, ...pinPoint(e, arrows.get(e.id)), text, resolved: ext(e)!.comment.status === "resolved" });
  }
  return pins;
}

/** 收起时每条批注留一个小圆点：在箭头指着的那一头（目标元素旁边），悬停看文字，点一下打开输入框 */
export function NotesLayer({ session, host, presenting }: { session: DocSession; host: HTMLElement | null; presenting: boolean }) {
  useViewTick();
  const folded = useShell((s) => s.notesFolded);
  const api = session.api;
  const els = (api?.getSceneElementsIncludingDeleted() ?? null) as El[] | null;
  const pins = useMemo(() => (folded && els ? pinsOf(els) : []), [folded, els]);
  const root = host?.querySelector<HTMLElement>(".excalidraw") ?? null;
  if (!folded || presenting || !api || !root || !pins.length) return null;
  const st = api.getAppState();
  const z = st.zoom.value;
  return createPortal(
    <div className="xd-pins">
      {pins.map((p) => {
        const left = (p.x + st.scrollX) * z, top = (p.y + st.scrollY) * z;
        if (left < -20 || top < -20 || left > st.width + 20 || top > st.height + 20) return null;
        return (
          <button
            key={p.id}
            type="button"
            className={`xd-pin${p.resolved ? " resolved" : ""}`}
            style={{ left, top }}
            aria-label={t("notes.pin")}
            onClick={() => editComment(session, p.id)}
          >
            <span className="xd-pin__peek">{p.text || t("notes.pin")}</span>
          </button>
        );
      })}
    </div>,
    root,
  );
}

// ── 藏起来的批注不能被双击、文字工具改到 ──────────────────
// 锁住的元素点不中、框选不到，但 Excalidraw 找「往哪个容器里写字」时不看 locked：
// 在藏着的便签上双击（或拿文字工具点一下）会去改它的文字，在藏着的箭头上双击会给它加标签。
// 收起时拦下这两种点击；那个位置有一条藏着的批注，就打开它的输入框。

/** 处理了返回 true（调用方别再往下传） */
export function guardFoldedClick(s: DocSession, e: React.MouseEvent, kind: "dblclick" | "pointerdown"): boolean {
  const api = s.api;
  if (!api || !getState().notesFolded || (e.target as HTMLElement).tagName !== "CANVAS") return false;
  const st = api.getAppState();
  if (kind === "pointerdown" && st.activeTool?.type !== "text") return false;
  const z = st.zoom.value;
  const x = (e.clientX - st.offsetLeft) / z - st.scrollX;
  const y = (e.clientY - st.offsetTop) / z - st.scrollY;
  const pad = 4 / z;
  const els = api.getSceneElements() as El[];
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (!isFolded(el) || !isCommentLike(el)) continue;
    const [x1, y1, x2, y2] = getCommonBounds([el as any]);
    if (x < x1 - pad || x > x2 + pad || y < y1 - pad || y > y2 + pad) continue;
    e.preventDefault();
    e.stopPropagation();
    const note = noteIdOf(el);
    if (note) editComment(s, note);
    return true;
  }
  return false;
}
