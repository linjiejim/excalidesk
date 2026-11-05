// 一个打开的文档 = 一个 DocSession。负责：脏检测、防抖保存、增量 delta、外部修改合并、视口记录。
//
// 保存链路（P0 实测后的定稿）：
//   onChange → getSceneVersion（O(n) 累加版本号，约 0.1ms）+ 需持久化的 appState 浅比较 → 没变就结束
//   变了 → 防抖 800ms、最长 5s → 只发 (version, versionNonce) 变了的元素 + 新图片 → Rust 维护整张图并写盘
//   会话里的第一次保存发全量，保证 Rust 模型和前端（restore 修复过的）元素完全一致。
import { CaptureUpdateAction, getSceneVersion, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import { ipc, type Viewport } from "./ipc";
import { getState, updateTab } from "./store";

type El = { id: string; version: number; versionNonce: number; isDeleted?: boolean; [k: string]: unknown };
type Files = Record<string, { id: string; [k: string]: unknown }>;
type Api = any;

const PERSISTED_APPSTATE = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled"] as const;
const persisted = (a: Record<string, unknown>) => Object.fromEntries(PERSISTED_APPSTATE.map((k) => [k, a[k]]));
const keyOf = (e: El) => `${e.version}:${e.versionNonce}`;

export class DocSession {
  readonly path: string;
  api: Api | null = null;
  /** 最新场景快照（引用即可，不复制）：切标签重挂载时作为 initialData */
  elements: readonly El[] = [];
  appState: Record<string, unknown> = {};
  files: Files = {};

  private saved = new Map<string, string>();
  private sentFiles = new Set<string>();
  private fullSync = true;
  private lastVersion = -1;
  private lastAppStateKey = "";
  private dirty = false;
  private debounce = 0;
  private maxWait = 0;
  private inflight: Promise<void> | null = null;
  private again = false;
  private viewportTimer = 0;

  debounceMs = 800;
  maxWaitMs = 5000;
  /** 自测用：最近一次保存发出的元素数和字节数 */
  lastSave = { upserts: 0, bytes: 0, files: 0, full: false };

  constructor(path: string) {
    this.path = path;
  }

  async load() {
    updateTab(this.path, { phase: getState().sync[this.path]?.dataless ? "downloading" : "loading" });
    const text = await ipc.openDoc(this.path);
    this.adopt(text);
    updateTab(this.path, { phase: "ready", save: "saved", elements: this.liveCount() });
  }

  /** 用磁盘内容（打开或外部修改后重读）作为基线 */
  private adopt(text: string) {
    const data = text.trim() ? JSON.parse(text) : {};
    this.elements = restoreElements(data.elements ?? [], null, { repairBindings: true }) as unknown as El[];
    this.appState = { ...(data.appState ?? {}) };
    this.files = data.files ?? {};
    this.markBaseline();
  }

  private markBaseline() {
    this.saved = new Map(this.elements.map((e) => [e.id, keyOf(e)]));
    this.sentFiles = new Set(Object.keys(this.files));
    this.lastVersion = getSceneVersion(this.elements as any);
    this.lastAppStateKey = JSON.stringify(persisted(this.appState));
    this.fullSync = true;
  }

  initialData() {
    const vp = getState().viewports[this.path];
    return {
      elements: this.elements as any,
      files: this.files as any,
      appState: {
        ...persisted(this.appState),
        ...(vp ? { scrollX: vp.scrollX, scrollY: vp.scrollY, zoom: { value: vp.zoom } } : {}),
      },
      scrollToContent: !vp,
    };
  }

  /**
   * Excalidraw 在构造函数里（React render 阶段）调用 excalidrawAPI，被 React 丢弃的那次 render 也会调用，
   * 所以拿到的 api 可能属于一个从没挂载的实例。这里只把它记成候选；真正的 api 由 onChange 确认：
   * onChange 只会由已挂载的实例触发，它传进来的 elements 和那个实例 getSceneElementsIncludingDeleted() 是同一个数组。
   */
  private candidates: Api[] = [];

  attach(api: Api | null) {
    if (api) {
      this.candidates = [...this.candidates.slice(-3), api];
    } else {
      this.api = null;
    }
  }

  private confirmApi(elements: readonly El[]) {
    if (this.api && this.api.getSceneElementsIncludingDeleted() === elements) return;
    const live = this.candidates.find((c) => c.getSceneElementsIncludingDeleted() === elements);
    if (live) this.api = live;
  }

  liveCount() {
    let n = 0;
    for (const e of this.elements) if (!e.isDeleted) n++;
    return n;
  }

  onChange = (elements: readonly El[], appState: Record<string, unknown>, files: Files) => {
    this.confirmApi(elements);
    this.elements = elements;
    this.appState = appState;
    this.files = files;
    const v = getSceneVersion(elements as any);
    const ak = JSON.stringify(persisted(appState));
    let newFile = false;
    for (const id in files) if (!this.sentFiles.has(id)) { newFile = true; break; }
    if (v === this.lastVersion && ak === this.lastAppStateKey && !newFile) return;
    this.lastVersion = v;
    this.lastAppStateKey = ak;
    this.markDirty();
  };

  private markDirty() {
    if (!this.dirty) {
      this.dirty = true;
      updateTab(this.path, { save: "dirty" });
      this.maxWait = window.setTimeout(() => this.flush(), this.maxWaitMs);
    }
    clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.flush(), this.debounceMs);
  }

  onScroll = (scrollX: number, scrollY: number, zoom: { value: number }) => {
    clearTimeout(this.viewportTimer);
    this.viewportTimer = window.setTimeout(() => this.saveViewport({ scrollX, scrollY, zoom: zoom.value }), 1000);
  };

  saveViewport(vp?: Viewport) {
    clearTimeout(this.viewportTimer);
    const a = this.api?.getAppState();
    const v = vp ?? (a ? { scrollX: a.scrollX, scrollY: a.scrollY, zoom: a.zoom.value } : null);
    if (!v) return;
    getState().viewports[this.path] = v;
    ipc.setViewport(this.path, v);
  }

  async flush(): Promise<void> {
    clearTimeout(this.debounce);
    clearTimeout(this.maxWait);
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    if (!this.dirty) return;
    this.inflight = this.doSave().finally(() => {
      this.inflight = null;
      if (this.again) {
        this.again = false;
        if (this.dirty) this.flush();
      }
    });
    return this.inflight;
  }

  private async doSave() {
    const els = this.elements;
    const versionAtStart = this.lastVersion;
    const upserts = this.fullSync ? els : els.filter((e) => this.saved.get(e.id) !== keyOf(e));
    const newFiles = Object.values(this.files).filter((f) => !this.sentFiles.has(f.id));
    const body = new TextEncoder().encode(
      `{"upserts":${JSON.stringify(upserts)},"appState":${JSON.stringify(persisted(this.appState))},"files":${JSON.stringify(newFiles)}}`,
    );
    updateTab(this.path, { save: "saving" });
    try {
      await ipc.saveDoc(this.path, body);
      for (const e of upserts) this.saved.set(e.id, keyOf(e));
      for (const f of newFiles) this.sentFiles.add(f.id);
      this.lastSave = { upserts: upserts.length, bytes: body.length, files: newFiles.length, full: this.fullSync };
      this.fullSync = false;
      // 保存期间又有改动：保持 dirty，交给下一轮
      this.dirty = this.lastVersion !== versionAtStart;
      updateTab(this.path, { save: this.dirty ? "dirty" : "saved", savedAt: Date.now(), saveError: undefined, elements: this.liveCount() });
      if (this.dirty) this.markDirty();
    } catch (e) {
      updateTab(this.path, { save: "error", saveError: String(e) });
      // 5 秒后重试
      this.maxWait = window.setTimeout(() => this.flush(), 5000);
    }
  }

  /**
   * 磁盘上的文件被别人改了（iCloud 下行、git pull、另一个编辑器）。
   * 本地没有未保存的修改 → 直接换成磁盘版本；有 → 用 Excalidraw 的 reconcileElements 按元素合并，再立即保存。
   */
  async checkExternal(): Promise<"none" | "replaced" | "merged"> {
    if (this.inflight) await this.inflight;
    if (!(await ipc.diskChanged(this.path))) return "none";
    const text = await ipc.openDoc(this.path);
    const data = text.trim() ? JSON.parse(text) : {};
    const remote = restoreElements(data.elements ?? [], null, { repairBindings: true }) as unknown as El[];
    const remoteFiles: Files = data.files ?? {};
    const local = this.api ? (this.api.getSceneElementsIncludingDeleted() as El[]) : this.elements;
    const localKeys = new Map(local.map((e) => [e.id, keyOf(e)]));
    const changed = remote.filter((e) => localKeys.get(e.id) !== keyOf(e)).length;
    const wasDirty = this.dirty;

    let next: readonly El[];
    if (!wasDirty) {
      next = remote;
    } else {
      const appState = this.api ? this.api.getAppState() : this.appState;
      next = reconcileElements(local as any, remote as any, appState) as unknown as El[];
    }
    this.files = { ...this.files, ...remoteFiles };
    this.elements = next;
    // 基线 = 磁盘版本；合并后本地胜出的元素自然会出现在下一次 delta 里
    this.saved = new Map(remote.map((e) => [e.id, keyOf(e)]));
    this.sentFiles = new Set(Object.keys(remoteFiles));
    this.fullSync = true;
    // 先更新基线版本号，updateScene 触发的 onChange 才不会被当成新改动
    this.lastVersion = getSceneVersion(next as any);
    if (this.api) {
      this.api.addFiles(Object.values(remoteFiles));
      this.api.updateScene({ elements: next, captureUpdate: wasDirty ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER });
    }
    const label = changed ? `外部修改了 ${changed} 个元素` : "文件在外部被修改";
    if (wasDirty) {
      updateTab(this.path, { banner: `${label}，已和你未保存的修改按元素合并`, elements: this.liveCount() });
      this.dirty = false;
      this.markDirty();
      await this.flush();
      return "merged";
    }
    this.dirty = false;
    updateTab(this.path, { banner: `${label}，已载入最新版本`, save: "saved", elements: this.liveCount() });
    return "replaced";
  }

  isDirty() {
    return this.dirty || !!this.inflight;
  }

  async close() {
    await this.flush();
    this.saveViewport();
    await ipc.closeDoc(this.path);
  }
}
