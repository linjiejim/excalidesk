// 外壳动作：工作区、标签页、新建、导出、监听、退出前保存。组件和菜单事件都只调这里。
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import { basename, dirname, ipc, isICloud } from "./ipc";
import { DocSession } from "./session";
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

const rootOf = (path: string) => getState().roots.find((r) => path === r || path.startsWith(r + "/"));

/** 工作区根目录递归监听；工作区外打开的文件监听它所在的文件夹 */
export async function rewatch() {
  const { roots, tabs } = getState();
  const outside = [...new Set(tabs.map((t) => t.path).filter((p) => !rootOf(p)).map(dirname))];
  await ipc.watch([...roots.map((r) => [r, true] as [string, boolean]), ...outside.map((d) => [d, false] as [string, boolean])]);
}

export async function addRoot(picked: string | null) {
  if (!picked) return;
  const path = await ipc.realPath(picked);
  await ipc.addWorkspace(path);
  setState((s) => ({ roots: s.roots.includes(path) ? s.roots : [...s.roots, path] }));
  await refreshTree(path);
  await rewatch();
}

export async function pickRoot() {
  return addRoot(await ipc.pickWorkspace());
}

export async function useICloudRoot() {
  try {
    await addRoot(await ipc.icloudDefaultDir());
  } catch (e) {
    toast(String(e));
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

export async function openPath(requested: string) {
  const path = await ipc.realPath(requested);
  if (!path.endsWith(".excalidraw")) {
    toast("只能打开 .excalidraw 文件");
    return;
  }
  if (sessions.has(path)) {
    await activate(path);
    return;
  }
  const s = new DocSession(path);
  sessions.set(path, s);
  setState((st) => ({
    tabs: [...st.tabs, { path, title: basename(path), phase: "loading", save: "saved", elements: 0 }],
  }));
  await activate(path);
  try {
    await s.load();
  } catch (e) {
    updateTab(path, { phase: "error", error: String(e) });
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
  setState({ active: path });
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
    return { tabs, active };
  });
  rewatch();
}

export function cycleTab(dir: 1 | -1) {
  const { tabs, active } = getState();
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.path === active);
  activate(tabs[(i + dir + tabs.length) % tabs.length].path);
}

/** 新建：放在当前文件所在的文件夹；没有就放第一个工作区 */
export async function newDoc() {
  const { active, roots } = getState();
  const dir = active && rootOf(active) ? dirname(active) : roots[0];
  if (!dir) {
    toast("先添加一个文件夹，新图会放在那里");
    await pickRoot();
    if (!getState().roots[0]) return;
    return newDoc();
  }
  const path = await ipc.createDoc(dir);
  const root = rootOf(path);
  if (root) await refreshTree(root);
  await openPath(path);
}

export async function openFileDialog() {
  const p = await ipc.pickOpenFile();
  if (p) await openPath(p);
}

export async function flushAll() {
  await Promise.all([...sessions.values()].map((s) => s.flush()));
  for (const s of sessions.values()) s.saveViewport();
}

export async function exportActive(kind: "png" | "svg", target?: string) {
  const { active } = getState();
  const s = active ? sessions.get(active) : null;
  if (!s?.api) return;
  const elements = s.api.getSceneElements();
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
  if (!target) toast(`已导出 ${path.split("/").pop()}`);
}

export async function refreshSync(path: string | null) {
  if (!path || !isICloud(path)) return;
  const st = await ipc.syncStatus(path);
  setState((s) => ({ sync: { ...s.sync, [path]: st } }));
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
    for (const s of sessions.values()) {
      if (list.some((p) => p === s.path || dirname(s.path) === p)) {
        try {
          await s.checkExternal();
        } catch (e) {
          toast(`读取外部修改失败：${e}`);
        }
      }
    }
  }, 150);
}

let closeAttempts = 0;
/** 退出前把所有文档存完；有存不进去的，第一次拦下提示，第二次才直接退出 */
export async function closeApp() {
  try {
    await flushAll();
  } catch {
    // 失败的标签会显示 error 状态
  }
  const bad = getState().tabs.filter((t) => t.save === "error" || t.save === "dirty");
  if (bad.length && closeAttempts++ === 0) {
    toast(`${bad.length} 个文件没保存成功（${bad.map((t) => t.title).join("、")}），再关一次会直接退出`);
    return;
  }
  await ipc.closeNow();
}

export function revealActive() {
  const { active } = getState();
  if (active) ipc.reveal(active);
}
