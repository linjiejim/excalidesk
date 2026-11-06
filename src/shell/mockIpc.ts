// 浏览器里（npm run dev / preview）没有 Tauri：用内存假实现跑同一套外壳 UI，方便看界面、调样式。
import type { Persisted, SaveResult, SyncStatus, TreeNode } from "./ipc";

const ROOT = "/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/Excalidraw";
const LOCAL = "/Users/demo/Code/docs";
const files = new Map<string, string>();
const empty = JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });
const seed = [`${ROOT}/产品/App 首页改版.excalidraw`, `${ROOT}/产品/用户旅程.excalidraw`, `${ROOT}/架构/系统架构.excalidraw`, `${ROOT}/架构/数据流.excalidraw`, `${LOCAL}/周会白板.excalidraw`];
seed.forEach((p) => files.set(p, empty));
const state: Persisted = { roots: [ROOT, LOCAL], recent: [`${ROOT}/架构/系统架构.excalidraw`], viewports: {} };

function tree(root: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const p of [...files.keys()].filter((f) => f.startsWith(root + "/")).sort()) {
    const parts = p.slice(root.length + 1).split("/");
    let level = out, base = root;
    for (const [i, part] of parts.entries()) {
      base += "/" + part;
      const isFile = i === parts.length - 1;
      let n = level.find((x) => x.path === base);
      if (!n) {
        n = { name: isFile ? part.replace(/\.excalidraw$/, "") : part, path: base, dir: !isFile, children: isFile ? undefined : [], mtime: 0, dataless: p.endsWith("数据流.excalidraw") };
        level.push(n);
      }
      level = n.children ?? [];
    }
  }
  return out;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const ok = <T>(v: T) => Promise.resolve(v);

export const mockIpc = {
  state: () => ok(state),
  pickWorkspace: () => ok(null),
  addWorkspace: () => ok(undefined),
  removeWorkspace: () => ok(undefined),
  icloudDefaultDir: () => ok(ROOT),
  tree: (root: string) => ok(tree(root)),
  watch: () => ok(undefined),
  setViewport: () => ok(undefined),
  syncStatus: (): Promise<SyncStatus> => ok({ ubiquitous: true, dataless: false, downloaded: true, uploaded: true, uploading: false, downloading: false, conflict: false }),
  reveal: () => ok(undefined),
  realPath: (p: string) => ok(p),
  takePendingOpens: () => ok([] as string[]),
  openDoc: async (p: string) => (p.endsWith("系统架构.excalidraw") ? fetch("/scenes/large.excalidraw").then((r) => r.text()) : files.get(p) ?? empty),
  diskStatus: () => ok("same"),
  closeDoc: () => ok(undefined),
  saveDoc: (_: string, body: Uint8Array): Promise<SaveResult> => ok({ bytes: body.length, elements: 0, ms: 1 }),
  createDoc: (dir: string) => { const p = `${dir}/未命名.excalidraw`; files.set(p, empty); return ok(p); },
  pickOpenFile: () => ok(null),
  pickSavePath: () => ok(null),
  writeBytes: (p: string, b: Uint8Array) => { files.set(p, decode(b)); return ok(undefined); },
  closeNow: () => ok(undefined),
  historyList: () => ok([{ id: "1", ts: Date.now() - 3600e3, reason: "auto", elements: 3048, bytes: 1 }, { id: "2", ts: Date.now() - 86400e3, reason: "before_external", elements: 3000, bytes: 1 }]),
  historyRead: () => fetch("/scenes/large.excalidraw").then((r) => r.text()),
  historySnapshot: () => ok(null),
  conflictsList: () => ok([]),
  conflictRead: () => ok(empty),
  conflictsResolve: () => ok(undefined),
  rename: (from: string, name: string) => ok(`${from.slice(0, from.lastIndexOf("/"))}/${name}`),
  duplicate: (p: string) => ok(p),
  trash: () => ok(""),
  mkdir: (parent: string) => ok(`${parent}/新建文件夹`),
  copyText: () => ok(undefined),
  confirm: (_t: string, m: string) => ok(window.confirm(m)),
  debugRemove: () => ok(undefined),
  selftestDir: () => ok("/tmp"),
  debugRead: (p: string) => ok(files.get(p) ?? ""),
  debugSize: () => ok(0),
  externalEdit: () => ok(undefined),
  benchResult: () => ok(""),
};
