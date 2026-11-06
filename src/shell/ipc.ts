// Rust 命令的类型化封装。大块数据（文档正文、导出图片）走原始字节，不经 JSON。
import { invoke } from "@tauri-apps/api/core";
import { mockIpc } from "./mockIpc";

export type Viewport = { scrollX: number; scrollY: number; zoom: number };
export type Persisted = { roots: string[]; recent: string[]; viewports: Record<string, Viewport> };
export type TreeNode = { name: string; path: string; dir: boolean; children?: TreeNode[]; mtime: number; dataless: boolean };
export type SyncStatus = { ubiquitous: boolean; dataless: boolean; downloaded: boolean; uploaded: boolean; uploading: boolean; downloading: boolean; conflict: boolean };
export type SaveResult = { bytes: number; elements: number; ms: number };
export type DiskStatus = "same" | "changed" | "missing";
export type HistoryEntry = { id: string; ts: number; reason: string; elements: number; bytes: number };
export type ConflictVersion = { path: string; device: string; modified: number };

const pathHeader = (path: string) => ({ headers: { path: encodeURIComponent(path) } });

const realIpc = {
  state: () => invoke<Persisted>("state_get"),
  pickWorkspace: () => invoke<string | null>("workspace_pick"),
  addWorkspace: (path: string) => invoke<void>("workspace_add", { path }),
  removeWorkspace: (path: string) => invoke<void>("workspace_remove", { path }),
  icloudDefaultDir: () => invoke<string>("icloud_default_dir"),
  tree: (root: string) => invoke<TreeNode[]>("tree", { root }),
  watch: (paths: [string, boolean][]) => invoke<void>("watch_set", { paths }),
  setViewport: (path: string, viewport: Viewport) => invoke<void>("viewport_set", { path, viewport }),
  syncStatus: (path: string) => invoke<SyncStatus>("sync_status", { path }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  realPath: (path: string) => invoke<string>("real_path", { path }),
  takePendingOpens: () => invoke<string[]>("take_pending_opens"),
  openDoc: async (path: string) => new TextDecoder().decode(await invoke<ArrayBuffer>("doc_open", { path })),
  diskStatus: (path: string) => invoke<DiskStatus>("doc_disk_status", { path }),
  closeDoc: (path: string) => invoke<void>("doc_close", { path }),
  saveDoc: (path: string, body: Uint8Array) => invoke<SaveResult>("doc_save", body, pathHeader(path)),
  createDoc: (dir: string, base?: string) => invoke<string>("doc_create", { dir, base }),
  pickOpenFile: () => invoke<string | null>("pick_open_file"),
  pickSavePath: (name: string, ext: string) => invoke<string | null>("pick_save_path", { name, ext }),
  writeBytes: (path: string, body: Uint8Array) => invoke<void>("write_bytes", body, pathHeader(path)),
  closeNow: () => invoke<void>("close_now"),
  historyList: (path: string) => invoke<HistoryEntry[]>("history_list", { path }),
  historyRead: async (path: string, id: string) => new TextDecoder().decode(await invoke<ArrayBuffer>("history_read", { path, id })),
  historySnapshot: (path: string, reason: string) => invoke<HistoryEntry | null>("history_snapshot", { path, reason }),
  conflictsList: (path: string) => invoke<ConflictVersion[]>("conflicts_list", { path }),
  conflictRead: async (versionPath: string) => new TextDecoder().decode(await invoke<ArrayBuffer>("conflict_read", { versionPath })),
  conflictsResolve: (path: string) => invoke<void>("conflicts_resolve", { path }),
  rename: (from: string, name: string) => invoke<string>("path_rename", { from, name }),
  duplicate: (path: string) => invoke<string>("path_duplicate", { path }),
  trash: (path: string) => invoke<string>("path_trash", { path }),
  mkdir: (parent: string, name?: string) => invoke<string>("dir_create", { parent, name }),
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  confirm: (title: string, message: string, ok: string) => invoke<boolean>("confirm", { title, message, ok }),
  // 自测辅助
  selftestDir: () => invoke<string>("selftest_dir"),
  debugRead: (path: string) => invoke<string>("debug_read", { path }),
  debugSize: (path: string) => invoke<number>("debug_size", { path }),
  debugRemove: (path: string) => invoke<void>("debug_remove", { path }),
  externalEdit: (path: string, element: unknown) => invoke<void>("external_edit", { path, element }),
  benchResult: (json: string) => invoke<string>("bench_result", { json }),
};

export const inTauri = "__TAURI_INTERNALS__" in window;
/** 浏览器里预览界面时用内存假实现 */
export const ipc: typeof realIpc = inTauri ? realIpc : (mockIpc as unknown as typeof realIpc);

export const basename = (p: string) => p.split("/").pop()!.replace(/\.excalidraw$/, "");
export const dirname = (p: string) => p.slice(0, p.lastIndexOf("/"));
export const isICloud = (p: string) => p.includes("/Library/Mobile Documents/");
