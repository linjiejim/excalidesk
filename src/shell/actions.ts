// 外壳动作：工作区、标签页、文件操作、导出、历史、监听、退出前保存。组件、菜单和右键菜单都只调这里。
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import { t, tErr } from "./i18n";
import { basename, dirname, inTauri, ipc, isICloud } from "./ipc";
import { DocSession } from "./session";
import { isCommentLike, type El } from "./elements";
import { getState, setState, toast, updateTab } from "./store";

export const sessions = new Map<string, DocSession>();

export async function boot() {
  const st = await ipc.state();
  setState({ roots: st.roots, recent: st.recent, viewports: st.viewports });
  await Promise.all(st.roots.map(refreshTree));
  await rewatch();
}

export async function refreshTree(root: string) {
  const nodes = await ipc.tree(root);
  setState((s) => ({ trees: { ...s.trees, [root]: nodes } }));
}

export const rootOf = (path: string) => getState().roots.find((r) => path === r || path.startsWith(r + "/"));
const refreshRootOf = (path: string) => {
  const r = rootOf(path);
  return r ? refreshTree(r) : Promise.resolve();
};
const under = (p: string, base: string) => p === base || p.startsWith(base + "/");

/** 工作区根目录递归监听；工作区外打开的文件监听它所在的文件夹 */
export async function rewatch() {
  const { roots, tabs } = getState();
  const outside = [...new Set(tabs.map((t) => t.path).filter((p) => !rootOf(p)).map(dirname))];
  await ipc.watch([...roots.map((r) => [r, true] as [string, boolean]), ...outside.map((d) => [d, false] as [string, boolean])]);
}

// ── 工作区 ─────────────────────────────────────────────

export async function addRoot(picked: string | null) {
  if (!picked) return;
  const path = await ipc.realPath(picked);
  await ipc.addWorkspace(path);
  setState((s) => ({ roots: s.roots.includes(path) ? s.roots : [...s.roots, path] }));
  await refreshTree(path);
  await rewatch();
}

export async function pickRoot() {
  return addRoot(await ipc.pickWorkspace(t("dialog.pickFolder")));
}

export async function useICloudRoot() {
  try {
    await addRoot(await ipc.icloudDefaultDir());
  } catch (e) {
    toast(tErr(e));
  }
}

export async function removeRoot(path: string) {
  await ipc.removeWorkspace(path);
  setState((s) => {
    const trees = { ...s.trees };
    delete trees[path];
    return { roots: s.roots.filter((r) => r !== path), trees };
  });
  await rewatch();
}

/** 侧边栏拖动工作区：把 from 放到 target 的上方或下方 */
export async function moveRoot(from: string, target: string, below: boolean) {
  if (from === target) return;
  const roots = getState().roots.filter((r) => r !== from);
  const j = roots.indexOf(target);
  if (j < 0) return;
  roots.splice(below ? j + 1 : j, 0, from);
  setState({ roots });
  try {
    await ipc.reorderRoots(roots);
  } catch (e) {
    toast(tErr(e));
  }
}

// ── 标签页 ─────────────────────────────────────────────

/** background：Agent 打开的图在后台标签里，不抢走用户正在看的那张（没有打开的图时照常切过去） */
export async function openPath(requested: string, opts: { background?: boolean } = {}) {
  const path = await ipc.realPath(requested);
  if (!path.endsWith(".excalidraw")) {
    toast(t("toast.onlyExcalidraw"));
    return;
  }
  if (sessions.has(path)) {
    if (!opts.background) await activate(path);
    return;
  }
  const s = new DocSession(path);
  sessions.set(path, s);
  setState((st) => ({
    tabs: [...st.tabs, { path, title: basename(path), phase: "loading", save: "saved", elements: 0, openedAt: Date.now(), agentDot: !!opts.background && !!st.active }],
  }));
  if (!opts.background || !getState().active) await activate(path);
  // iCloud 里还没下载的文件：先拿到状态，界面显示「正在下载」而不是「正在打开」
  if (isICloud(path)) await refreshSync(path).catch(() => {});
  try {
    await s.load();
  } catch (e) {
    updateTab(path, { phase: "error", error: tErr(e) });
  }
  setState((st) => ({ recent: [path, ...st.recent.filter((r) => r !== path)].slice(0, 20) }));
  refreshSync(path);
  if (!rootOf(path)) rewatch();
}

export async function activate(path: string) {
  const { active } = getState();
  if (active === path) return;
  const prev = active ? sessions.get(active) : null;
  if (prev) {
    prev.saveViewport();
    prev.flush();
  }
  setState((s) => ({ active: path, history: false, commentDraft: null, tabs: s.tabs.map((t) => (t.path === path && t.agentDot ? { ...t, agentDot: false } : t)) }));
}

export async function closeTab(path: string | null) {
  if (!path) return;
  const s = sessions.get(path);
  if (s) await s.close();
  sessions.delete(path);
  setState((st) => {
    const i = st.tabs.findIndex((t) => t.path === path);
    const tabs = st.tabs.filter((t) => t.path !== path);
    const active = st.active === path ? (tabs[Math.min(i, tabs.length - 1)]?.path ?? null) : st.active;
    return { tabs, active, history: st.active === path ? false : st.history };
  });
  rewatch();
}

export async function closeOthers(keep: string) {
  for (const t of getState().tabs) if (t.path !== keep) await closeTab(t.path);
  await activate(keep);
}

export function cycleTab(dir: 1 | -1) {
  const { tabs, active } = getState();
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.path === active);
  activate(tabs[(i + dir + tabs.length) % tabs.length].path);
}

// ── 新建 / 文件操作 ────────────────────────────────────

/** 新建：指定文件夹，或当前文件所在的文件夹，或第一个工作区 */
export async function newDoc(dir?: string) {
  const { active, roots } = getState();
  const target = dir ?? (active && rootOf(active) ? dirname(active) : roots[0]);
  if (!target) {
    toast(t("toast.addFolderFirst"));
    await pickRoot();
    if (!getState().roots[0]) return;
    return newDoc();
  }
  const path = await ipc.createDoc(target, t("app.untitled"));
  await refreshRootOf(path);
  await openPath(path);
}

export async function newFolder(parent: string) {
  try {
    const p = await ipc.mkdir(parent, t("app.newFolder"));
    await refreshRootOf(p);
    setState({ renaming: p });
  } catch (e) {
    toast(t("toast.mkdirFailed", { error: tErr(e) }));
  }
}

/** 重命名文件或文件夹：打开中的标签、视口、最近打开、历史版本都跟着改 */
export async function renamePath(from: string, name: string) {
  setState({ renaming: null });
  const current = from.split("/").pop()!.replace(/\.excalidraw$/, "");
  if (!name.trim() || name.trim() === current) return;
  let to: string;
  try {
    const s = sessions.get(from);
    if (s) await s.flush();
    to = await ipc.rename(from, name);
  } catch (e) {
    toast(tErr(e));
    return;
  }
  const map = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : null);
  for (const [p, s] of [...sessions]) {
    const n = map(p);
    if (n) {
      sessions.delete(p);
      s.path = n;
      sessions.set(n, s);
    }
  }
  setState((st) => {
    const viewports: typeof st.viewports = {};
    for (const [k, v] of Object.entries(st.viewports)) viewports[map(k) ?? k] = v;
    return {
      tabs: st.tabs.map((t) => {
        const n = map(t.path);
        return n ? { ...t, path: n, title: basename(n) } : t;
      }),
      active: st.active ? (map(st.active) ?? st.active) : null,
      recent: st.recent.map((r) => map(r) ?? r),
      viewports,
    };
  });
  await refreshRootOf(to);
  await rewatch();
}

export async function duplicatePath(path: string) {
  try {
    const s = sessions.get(path);
    if (s) await s.flush();
    const p = await ipc.duplicate(path, t("app.copySuffix"));
    await refreshRootOf(p);
    toast(t("toast.created", { name: basename(p) }));
  } catch (e) {
    toast(t("toast.duplicateFailed", { error: tErr(e) }));
  }
}

export async function trashPath(path: string, isDir: boolean) {
  const name = path.split("/").pop()!;
  if (isDir && !(await ipc.confirm(t("dialog.trashTitle"), t("dialog.trashFolder", { name }), t("menu.trash"), t("app.cancel")))) return;
  // 关掉受影响的标签，不再保存（否则会把刚删掉的文件写回来）
  for (const [p, s] of [...sessions]) {
    if (under(p, path)) {
      s.missing = true;
      await closeTab(p);
    }
  }
  try {
    await ipc.trash(path);
    toast(t("toast.trashed", { name: name.replace(/\.excalidraw$/, "") }));
  } catch (e) {
    toast(t("toast.trashFailed", { error: tErr(e) }));
    return;
  }
  // 最近打开里也拿掉
  await ipc.recentRemove(path);
  setState((st) => ({ recent: st.recent.filter((r) => !under(r, path)) }));
  await refreshRootOf(path);
}

export async function removeRecent(path: string) {
  await ipc.recentRemove(path);
  setState((st) => ({ recent: st.recent.filter((r) => r !== path) }));
}

export async function copyPath(path: string) {
  await ipc.copyText(path);
  toast(t("toast.pathCopied"));
}

export async function openFileDialog() {
  const p = await ipc.pickOpenFile();
  if (p) await openPath(p);
}

/** 文件被移走后：另存到别的位置，并在新位置继续编辑 */
export async function saveMissingAs(path: string) {
  const s = sessions.get(path);
  if (!s) return;
  const target = await ipc.pickSavePath(basename(path), "excalidraw");
  if (!target) return;
  await ipc.writeBytes(target, new TextEncoder().encode(s.serializeAll()));
  await closeTab(path);
  await openPath(target);
}

export async function flushAll() {
  await Promise.all([...sessions.values()].map((s) => s.flush()));
  for (const s of sessions.values()) s.saveViewport();
}

// ── 导出 / 历史 ────────────────────────────────────────

export async function exportActive(kind: "png" | "svg", target?: string) {
  const { active } = getState();
  const s = active ? sessions.get(active) : null;
  if (!s?.api) return;
  // 给 Agent 的批注不导出
  const elements = s.api.getSceneElements().filter((e: El) => !isCommentLike(e));
  const appState = { ...s.api.getAppState(), exportBackground: true, exportWithDarkMode: false };
  const files = s.api.getFiles();
  const path = target ?? (await ipc.pickSavePath(basename(s.path), kind));
  if (!path) return;
  let bytes: Uint8Array;
  if (kind === "png") {
    const blob = await exportToBlob({ elements, appState, files, mimeType: "image/png", exportPadding: 16, getDimensions: (w: number, h: number) => ({ width: w * 2, height: h * 2, scale: 2 }) });
    bytes = new Uint8Array(await blob.arrayBuffer());
  } else {
    const svg = await exportToSvg({ elements, appState, files, exportPadding: 16 });
    bytes = new TextEncoder().encode(svg.outerHTML);
  }
  await ipc.writeBytes(path, bytes);
  if (!target) toast(t("toast.exported", { name: path.split("/").pop()! }));
}

export function toggleHistory(open?: boolean) {
  if (!getState().active) return;
  setState((s) => ({ history: open ?? !s.history }));
}

export async function restoreHistory(id: string) {
  const { active } = getState();
  const s = active ? sessions.get(active) : null;
  if (!s) return;
  await s.restoreHistory(id);
  setState({ history: false });
}

/** 把某个历史版本另存成同目录下的新文件并打开 */
export async function historyAsCopy(id: string, ts: number) {
  const { active } = getState();
  if (!active) return;
  const d = new Date(ts);
  const stamp = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  const text = await ipc.historyRead(active, id);
  const p = await ipc.createDoc(dirname(active), t("history.copyName", { name: basename(active), stamp }));
  await ipc.writeBytes(p, new TextEncoder().encode(text));
  await refreshRootOf(p);
  setState({ history: false });
  await openPath(p);
}

// ── iCloud / 监听 / 退出 ───────────────────────────────

const resolving = new Set<string>();
export async function refreshSync(path: string | null) {
  if (!path || !isICloud(path)) return;
  const st = await ipc.syncStatus(path);
  setState((s) => ({ sync: { ...s.sync, [path]: st } }));
  // 发现 iCloud 冲突版本：自动按元素合并
  const s = sessions.get(path);
  if (st.conflict && s && s.api && !resolving.has(path)) {
    resolving.add(path);
    try {
      await s.resolveConflicts();
    } catch (e) {
      toast(t("toast.conflictFailed", { error: tErr(e) }));
    } finally {
      resolving.delete(path);
    }
  }
}

let fsTimer = 0;
const changedPaths = new Set<string>();
/** FSEvents（已在 Rust 侧合并 300ms）→ 刷新受影响的树 + 检查打开的文档有没有被外部改 */
export function onFsChanged(paths: string[]) {
  paths.forEach((p) => changedPaths.add(p));
  clearTimeout(fsTimer);
  fsTimer = window.setTimeout(async () => {
    const list = [...changedPaths];
    changedPaths.clear();
    const roots = new Set(list.map(rootOf).filter(Boolean) as string[]);
    roots.forEach(refreshTree);
    for (const s of [...sessions.values()]) {
      if (list.some((p) => p === s.path || dirname(s.path) === p || under(s.path, p))) {
        try {
          await s.checkExternal();
        } catch (e) {
          toast(t("toast.externalFailed", { error: tErr(e) }));
        }
      }
    }
  }, 150);
}

let closeAttempts = 0;
/** 退出（或装好更新后重启）前把所有文档存完；有存不进去的，第一次拦下提示，第二次才直接退出 */
export async function closeApp(restart = false) {
  try {
    await flushAll();
  } catch {
    // 失败的标签会显示 error 状态
  }
  const bad = getState().tabs.filter((t) => !t.missing && (t.save === "error" || t.save === "dirty"));
  if (bad.length && closeAttempts++ === 0) {
    toast(t(restart ? "toast.unsavedRestart" : "toast.unsaved", { n: bad.length, names: bad.map((x) => x.title).join(getState().lang === "zh" ? "、" : ", ") }));
    return;
  }
  await (restart ? ipc.restartNow() : ipc.closeNow());
}

export function revealActive() {
  const { active } = getState();
  if (active) ipc.reveal(active);
}

/** 窗口标题（标题栏隐藏了，但会出现在「窗口」菜单和调度中心里） */
export async function syncWindowTitle(title: string) {
  if (!inTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  getCurrentWindow().setTitle(title ? `${title} — Excalidesk` : "Excalidesk");
}

/** 原生部分跟着设置走：菜单语言、窗口外观（红绿灯、滚动条、系统对话框的深浅色） */
export async function syncNative(lang: "zh" | "en", theme: "system" | "light" | "dark") {
  if (!inTauri) return;
  await ipc.setMenuLang(lang).catch(() => {});
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(() => {});
}
