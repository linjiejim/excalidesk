// 一个打开的文档 = 一个 DocSession。负责：脏检测、防抖保存、增量 delta、外部修改合并、iCloud 冲突、历史恢复、视口记录。
//
// 保存链路（P0 实测后的定稿）：
//   onChange → getSceneVersion（O(n) 累加版本号，约 0.1ms）+ 需持久化的 appState 浅比较 → 没变就结束
//   变了 → 防抖 800ms、最长 5s → 只发 (version, versionNonce) 变了的元素 + 新图片 → Rust 维护整张图并写盘
//   会话里的第一次保存发全量，保证 Rust 模型和前端（restore 修复过的）元素完全一致。
import { CaptureUpdateAction, getSceneVersion, reconcileElements, restoreAppState, restoreElements } from "@excalidraw/excalidraw";
import { ipc, type Viewport } from "./ipc";
import { getState, updateTab } from "./store";

type El = { id: string; version: number; versionNonce: number; isDeleted?: boolean; [k: string]: unknown };
type Files = Record<string, { id: string; [k: string]: unknown }>;
type Api = any;

const PERSISTED_APPSTATE = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled"] as const;
const persisted = (a: Record<string, unknown>) => Object.fromEntries(PERSISTED_APPSTATE.map((k) => [k, a[k]]));
const keyOf = (e: El) => `${e.version}:${e.versionNonce}`;
const nonce = () => (Math.random() * 2 ** 31) | 0;
/** 兜底：挂载后这段时间内、用户还没动过画布时，Excalidraw 自己做的规整不算改动 */
const SETTLE_MS = 4000;

const parse = (text: string) => {
  const data = text.trim() ? JSON.parse(text) : {};
  return {
    elements: restoreElements(data.elements ?? [], null, { repairBindings: true }) as unknown as El[],
    // 和 Excalidraw 挂载时做的规整保持一致（补齐 gridStep 等默认值），否则一打开就会被当成「有改动」
    appState: restoreAppState(data.appState ?? {}, null) as unknown as Record<string, unknown>,
    files: (data.files ?? {}) as Files,
  };
};

let uidCounter = 0;

export class DocSession {
  /** 重命名不改它：Excalidraw 实例按它作 key，改名不用重新挂载 */
  readonly uid = ++uidCounter;
  path: string;
  api: Api | null = null;
  /** 最新场景快照（引用即可，不复制）：切标签重挂载时作为 initialData */
  elements: readonly El[] = [];
  appState: Record<string, unknown> = {};
  files: Files = {};
  /** 文件在外部被删除或移走：暂停自动保存，等用户决定 */
  missing = false;

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
  private settleUntil = 0;
  private candidates: Api[] = [];

  debounceMs = 800;
  maxWaitMs = 5000;
  /** 自测用：最近一次保存发出的元素数和字节数 */
  lastSave = { upserts: 0, bytes: 0, files: 0, full: false };
  saves = 0;

  constructor(path: string) {
    this.path = path;
  }

  async load() {
    updateTab(this.path, { phase: getState().sync[this.path]?.dataless ? "downloading" : "loading" });
    this.adopt(parse(await ipc.openDoc(this.path)));
    updateTab(this.path, { phase: "ready", save: "saved", elements: this.liveCount() });
  }

  /** 用磁盘内容作为基线 */
  private adopt(d: ReturnType<typeof parse>) {
    this.elements = d.elements;
    this.appState = { ...d.appState };
    this.files = d.files;
    this.saved = new Map(d.elements.map((e) => [e.id, keyOf(e)]));
    this.sentFiles = new Set(Object.keys(d.files));
    this.lastVersion = getSceneVersion(d.elements as any);
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
  attach(api: Api | null) {
    if (api) {
      this.candidates = [...this.candidates.slice(-3), api];
      this.settleUntil = performance.now() + SETTLE_MS;
    } else {
      this.api = null;
    }
  }

  private confirmApi(elements: readonly El[]) {
    if (this.api && this.api.getSceneElementsIncludingDeleted() === elements) return;
    const live = this.candidates.find((c) => c.getSceneElementsIncludingDeleted() === elements);
    if (live) this.api = live;
  }

  /** 用户在画布上按键或按下指针：规整期结束，之后的变化都算改动 */
  userInput = () => {
    this.settleUntil = 0;
  };

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
    // 规整期：只更新基线版本号，不标脏、不写盘（这些元素会跟着下一次真正的改动一起存）
    if (!this.dirty && performance.now() < this.settleUntil && !newFile) return;
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
    if (!v || this.missing) return;
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
    if (!this.dirty || this.missing) return;
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
      this.saves++;
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

  private current() {
    return {
      elements: (this.api ? this.api.getSceneElementsIncludingDeleted() : this.elements) as El[],
      appState: this.api ? this.api.getAppState() : this.appState,
    };
  }

  /** 把一组新元素放进画布；undoable=true 时用户可以 ⌘Z 撤销 */
  private apply(next: readonly El[], files: Files, undoable: boolean) {
    this.files = { ...this.files, ...files };
    this.elements = next;
    if (this.api) {
      this.api.addFiles(Object.values(files));
      this.api.updateScene({ elements: next, captureUpdate: undoable ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER });
    }
  }

  /**
   * 磁盘上的文件变了（iCloud 下行、git pull、另一个编辑器）或者没了。
   * 本地没有未保存的修改 → 直接换成磁盘版本；有 → 用 reconcileElements 按元素合并，再立即保存。
   */
  async checkExternal(): Promise<"none" | "replaced" | "merged" | "missing"> {
    if (this.inflight) await this.inflight;
    const status = await ipc.diskStatus(this.path);
    if (status === "missing") {
      if (!this.missing) {
        this.missing = true;
        clearTimeout(this.debounce);
        updateTab(this.path, { missing: true, banner: undefined });
      }
      return "missing";
    }
    if (status === "same" && !this.missing) return "none";
    const wasMissing = this.missing;
    this.missing = false;
    updateTab(this.path, { missing: false });
    // 先给当前内容留一份历史，再读磁盘（读的同时 Rust 侧的模型会换成磁盘版本）
    await ipc.historySnapshot(this.path, "before_external");
    const remote = parse(await ipc.openDoc(this.path));
    const local = this.current();
    const localKeys = new Map(local.elements.map((e) => [e.id, keyOf(e)]));
    const changed = remote.elements.filter((e) => localKeys.get(e.id) !== keyOf(e)).length;
    const wasDirty = this.dirty || wasMissing;

    const next = wasDirty ? (reconcileElements(local.elements as any, remote.elements as any, local.appState) as unknown as El[]) : remote.elements;
    // 基线 = 磁盘版本；合并后本地胜出的元素自然会出现在下一次 delta 里
    this.saved = new Map(remote.elements.map((e) => [e.id, keyOf(e)]));
    this.sentFiles = new Set(Object.keys(remote.files));
    this.fullSync = true;
    // 先更新基线版本号，updateScene 触发的 onChange 才不会被当成新改动
    this.lastVersion = getSceneVersion(next as any);
    this.apply(next, remote.files, wasDirty);
    const label = changed ? `外部修改了 ${changed} 个元素` : "文件在外部被修改";
    if (wasDirty) {
      updateTab(this.path, { banner: `${label}，已和你未保存的修改按元素合并（⌘Z 可撤销）`, elements: this.liveCount() });
      this.dirty = false;
      this.markDirty();
      await this.flush();
      return "merged";
    }
    this.dirty = false;
    updateTab(this.path, { banner: `${label}，已载入最新版本`, save: "saved", elements: this.liveCount() });
    return "replaced";
  }

  /** 文件被移走后，按原路径重新存一份 */
  async restoreAtPath() {
    this.missing = false;
    this.fullSync = true;
    this.dirty = true;
    updateTab(this.path, { missing: false });
    await this.flush();
  }

  /** 当前画布内容的完整 .excalidraw（另存为用） */
  serializeAll() {
    const { elements, appState } = this.current();
    return JSON.stringify({ type: "excalidraw", version: 2, source: "Excalidesk", elements, appState: persisted(appState), files: this.files }, null, 2);
  }

  /**
   * iCloud 冲突：两台设备同时改了同一个文件，系统会留下「冲突版本」。
   * 逐个读出来按元素合并进当前内容，保存，再把冲突标记为已解决。
   */
  async resolveConflicts(): Promise<number> {
    const versions = await ipc.conflictsList(this.path);
    if (!versions.length) return 0;
    if (this.inflight) await this.inflight;
    await ipc.historySnapshot(this.path, "before_conflict");
    let { elements, appState } = this.current();
    let files: Files = {};
    for (const v of versions) {
      const remote = parse(await ipc.conflictRead(v.path));
      elements = reconcileElements(elements as any, remote.elements as any, appState) as unknown as El[];
      files = { ...files, ...remote.files };
    }
    this.lastVersion = getSceneVersion(elements as any);
    this.apply(elements, files, true);
    this.fullSync = true;
    this.markDirty();
    await this.flush();
    await ipc.conflictsResolve(this.path);
    const devices = [...new Set(versions.map((v) => v.device).filter(Boolean))].join("、");
    updateTab(this.path, { banner: `已合并 ${versions.length} 个来自${devices ? `「${devices}」` : "其他设备"}的冲突版本（⌘Z 可撤销）`, elements: this.liveCount() });
    return versions.length;
  }

  /**
   * 恢复历史版本：作为一次可撤销的修改。快照里没有的元素标成删除（墓碑），
   * 快照里的元素版本号抬高，保证它们在之后的合并里胜出。
   */
  async restoreHistory(id: string) {
    if (this.inflight) await this.inflight;
    await ipc.historySnapshot(this.path, "before_restore");
    const snap = parse(await ipc.historyRead(this.path, id));
    const { elements } = this.current();
    const top = Math.max(0, ...elements.map((e) => e.version)) + 1;
    const inSnap = new Set(snap.elements.map((e) => e.id));
    const next: El[] = [
      ...snap.elements.map((e) => ({ ...e, version: Math.max(e.version, top), versionNonce: nonce() })),
      ...elements.filter((e) => !inSnap.has(e.id) && !e.isDeleted).map((e) => ({ ...e, isDeleted: true, version: top, versionNonce: nonce() })),
    ];
    this.apply(next, snap.files, true);
    this.settleUntil = 0;
    this.markDirty();
    await this.flush();
    updateTab(this.path, { banner: "已恢复到所选历史版本（⌘Z 可撤销）", elements: this.liveCount() });
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
