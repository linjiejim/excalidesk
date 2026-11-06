// 外壳状态：一个极简的外部 store，组件按 selector 订阅，外壳变化不会连带 Excalidraw 重渲染。
import { useSyncExternalStore } from "react";
import type { SyncStatus, TreeNode, Viewport } from "./ipc";

export type SaveState = "saved" | "dirty" | "saving" | "error";

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
};

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
  /** 侧边栏里正在行内重命名的路径 */
  renaming: string | null;
  history: boolean;
  fullscreen: boolean;
  sidebarWidth: number;
};

let state: ShellState = {
  roots: [], trees: {}, recent: [], viewports: {}, tabs: [], active: null,
  sidebar: localStorage.getItem("sidebar") !== "0", focus: false, sync: {},
  renaming: null, history: false, fullscreen: false,
  sidebarWidth: Number(localStorage.getItem("sidebarWidth")) || 240,
};
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
