// 收起批注（docs/specs/20261124-fold-notes.md）：开关（⇧C）、收起后画布上的小圆点。
// 藏起来的批注是锁住的：Excalidraw 0.18.1 点击、框选、双击写字、文字工具、橡皮擦都会跳过锁住的元素，不用另外拦。
// 批注在画布上怎么藏、存盘和 Agent 读写时怎么还原，见 elements.ts（fold / unfold）和 session.ts。
import { useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { sessions } from "./actions";
import { editComment } from "./agent";
import { boundTextOf, commentOf, ext, isComment, pinPoint, REPLY_SEP, type El } from "./elements";
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
  // 正在改的那条：小圆点高亮、不再浮出文字（输入框里就是它）
  const editing = useShell((s) => (s.commentDraft?.path === session.path ? s.commentDraft.editing : undefined));
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
            className={`xd-pin${p.resolved ? " resolved" : ""}${p.id === editing ? " active" : ""}`}
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
