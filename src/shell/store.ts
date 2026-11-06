// 外壳状态：一个极简的外部 store，组件按 selector 订阅，外壳变化不会连带 Excalidraw 重渲染。
import { useSyncExternalStore } from "react";
import type { SyncStatus, TreeNode, Viewport } from "./ipc";

export type SaveState = "saved" | "dirty" | "saving" | "error";

export type Settings = {
  theme: "system" | "light" | "dark";
  lang: "system" | "zh" | "en";
  /** 侧边栏排序，默认最新修改的在上面 */
  sort: "mtime" | "ctime" | "name";
  /** 启动时和之后每隔几小时查一次新版本，下载装好 */
  autoUpdate: boolean;
};
const DEFAULT_SETTINGS: Settings = { theme: "system", lang: "system", sort: "mtime", autoUpdate: true };
const loadSettings = (): Settings => {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("settings") ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
};
const effectiveLang = (s: Settings): "zh" | "en" =>
  s.lang !== "system" ? s.lang : navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";

export type Tab = {
  path: string;
  title: string;
  phase: "loading" | "downloading" | "ready" | "error";
  error?: string;
  save: SaveState;
  savedAt?: number;
  saveError?: string;
  elements: number;
  banner?: string;
  /** 文件在外部被删除或移走 */
  missing?: boolean;
  /** 开始打开的时间：打开太久时提示可能在等 iCloud 下载 */
  openedAt?: number;
};

/** 等用户处理的提示（装好的更新等重启）：不自动消失，普通 toast 也顶不掉它 */
export type Prompt = { id: string; msg: string; action?: { label: string; run: () => void } };

export type ShellState = {
  roots: string[];
  trees: Record<string, TreeNode[]>;
  recent: string[];
  viewports: Record<string, Viewport>;
  tabs: Tab[];
  active: string | null;
  sidebar: boolean;
  focus: boolean;
  sync: Record<string, SyncStatus>;
  toast?: string;
  prompt?: Prompt;
  /** 侧边栏里正在行内重命名的路径 */
  renaming: string | null;
  history: boolean;
  fullscreen: boolean;
  sidebarWidth: number;
  settings: Settings;
  /** 实际生效的界面语言 */
  lang: "zh" | "en";
  settingsOpen: boolean;
};

let state: ShellState = {
  roots: [], trees: {}, recent: [], viewports: {}, tabs: [], active: null,
  sidebar: localStorage.getItem("sidebar") !== "0", focus: false, sync: {},
  renaming: null, history: false, fullscreen: false,
  sidebarWidth: Number(localStorage.getItem("sidebarWidth")) || 240,
  settings: loadSettings(),
  lang: effectiveLang(loadSettings()),
  settingsOpen: false,
};

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...state.settings, ...patch };
  localStorage.setItem("settings", JSON.stringify(settings));
  setState({ settings, lang: effectiveLang(settings) });
}
const listeners = new Set<() => void>();

export const getState = () => state;
export function setState(patch: Partial<ShellState> | ((s: ShellState) => Partial<ShellState>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function updateTab(path: string, patch: Partial<Tab>) {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, ...patch } : t)) }));
}
export function useShell<T>(selector: (s: ShellState) => T): T {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => selector(state),
  );
}

let toastTimer = 0;
export function toast(msg: string) {
  setState({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setState({ toast: undefined }), 3500);
}

/** 同一个 id 再显示就替换掉 */
export const showPrompt = (prompt: Prompt) => setState({ prompt });
/** 只关掉这个 id 的，别的提示已经顶上来就不动 */
export function hidePrompt(id: string) {
  if (getState().prompt?.id === id) setState({ prompt: undefined });
}
