// 端到端自测（--selftest）：在临时工作区里把 P1 的主路径都走一遍，结果写到结果目录后退出。
import { CaptureUpdateAction, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { addRoot, activate, closeTab, exportActive, newDoc, openPath, sessions } from "./actions";
import { ipc } from "./ipc";
import { getState } from "./store";

type Step = { name: string; ok: boolean; ms: number; detail?: unknown };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(f: () => T | Promise<T>, ms = 8000, every = 100): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error("超时");
    await sleep(every);
  }
}
const rect = (x: number, y: number, extra: Record<string, unknown> = {}) =>
  convertToExcalidrawElements([{ type: "rectangle", x, y, width: 120, height: 80, ...extra } as any], { regenerateIds: false })[0] as any;
const fileIds = (text: string) => (JSON.parse(text).elements as any[]).map((e) => e.id);
const session = (p: string) => sessions.get(p)!;
const ready = (p: string) => getState().tabs.find((t) => t.path === p)?.phase === "ready" && !!session(p)?.api;

const pageErrors: string[] = [];
window.addEventListener("error", (e) => pageErrors.push(`${e.message} @${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => pageErrors.push(`unhandled: ${(e.reason as Error)?.message ?? e.reason}`));
const origError = console.error;
console.error = (...a: unknown[]) => { pageErrors.push(a.map(String).join(" ").slice(0, 400)); origError(...a); };

export async function runSelftest() {
  const steps: Step[] = [];
  const step = async (name: string, f: () => Promise<unknown>) => {
    const t0 = performance.now();
    try {
      const detail = await f();
      steps.push({ name, ok: true, ms: Math.round(performance.now() - t0), detail });
    } catch (e) {
      const st = getState();
      steps.push({
        name, ok: false, ms: Math.round(performance.now() - t0),
        detail: { error: String((e as Error)?.message ?? e), tabs: st.tabs.map((t) => [t.title, t.phase, t.save, t.banner]), active: st.active, api: [...sessions].map(([p, x]) => [p.split("/").pop(), !!x.api, x.elements.length]), pageErrors: [...pageErrors] },
      });
      pageErrors.length = 0;
    }
  };

  const dir = await ipc.realPath(await ipc.selftestDir());
  const big = `${dir}/大图.excalidraw`;
  const small = `${dir}/子文件夹/小图.excalidraw`;

  await step("准备工作区并扫描文件树", async () => {
    await ipc.writeBytes(big, new Uint8Array(await (await fetch("/scenes/large.excalidraw")).arrayBuffer()));
    const scene = { type: "excalidraw", version: 2, elements: [rect(0, 0), rect(200, 0)], appState: {}, files: {} };
    await ipc.writeBytes(small, new TextEncoder().encode(JSON.stringify(scene)));
    await addRoot(dir);
    const tree = getState().trees[dir];
    const names = JSON.stringify(tree);
    if (!names.includes("大图") || !names.includes("小图")) throw new Error(`树里缺文件：${names}`);
    return tree.map((n) => n.name);
  });

  await step("打开小图", async () => {
    await openPath(small);
    await waitFor(() => ready(small));
    const n = session(small).api.getSceneElements().length;
    if (n !== 2) throw new Error(`元素数 ${n}`);
    return { elements: n };
  });

  let added: any;
  await step("编辑后自动保存（会话首次保存 = 全量）", async () => {
    const s = session(small);
    added = rect(400, 0);
    s.api.updateScene({ elements: [...s.api.getSceneElementsIncludingDeleted(), added], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    await waitFor(async () => fileIds(await ipc.debugRead(small)).includes(added.id), 5000);
    return s.lastSave;
  });

  await step("第二次编辑只发 1 个元素（增量）", async () => {
    const s = session(small);
    const els = s.api.getSceneElementsIncludingDeleted().map((e: any) => (e.id === added.id ? { ...e, x: e.x + 50, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e));
    s.api.updateScene({ elements: els, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    await waitFor(async () => (JSON.parse(await ipc.debugRead(small)).elements as any[]).find((e) => e.id === added.id)?.x === 450, 5000);
    if (s.lastSave.full || s.lastSave.upserts !== 1) throw new Error(JSON.stringify(s.lastSave));
    return s.lastSave;
  });

  await step("外部修改（本地无改动）→ 自动载入", async () => {
    const ext = rect(0, 300, { id: "external-clean" });
    await ipc.externalEdit(small, ext);
    await waitFor(() => session(small).api.getSceneElements().some((e: any) => e.id === "external-clean"), 6000);
    return getState().tabs.find((t) => t.path === small)?.banner;
  });

  await step("外部修改（本地有未保存改动）→ 按元素合并并保存", async () => {
    const s = session(small);
    s.debounceMs = 8000;
    s.maxWaitMs = 8000;
    const local = rect(200, 300, { id: "local-dirty" });
    s.api.updateScene({ elements: [...s.api.getSceneElementsIncludingDeleted(), local], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    await sleep(50);
    if (!s.isDirty()) throw new Error("本地应为未保存状态");
    await ipc.externalEdit(small, rect(400, 300, { id: "external-dirty" }));
    await waitFor(async () => {
      const ids = fileIds(await ipc.debugRead(small));
      return ids.includes("local-dirty") && ids.includes("external-dirty") && ids.includes("external-clean");
    }, 8000);
    s.debounceMs = 800;
    s.maxWaitMs = 5000;
    const scene = s.api.getSceneElements().map((e: any) => e.id);
    if (!scene.includes("local-dirty") || !scene.includes("external-dirty")) throw new Error("画布上缺元素");
    return getState().tabs.find((t) => t.path === small)?.banner;
  });

  await step("打开 3000 元素大图", async () => {
    session(small).api.updateScene({ appState: { scrollX: 123, scrollY: 45, zoom: { value: 0.8 } }, captureUpdate: CaptureUpdateAction.NEVER });
    await sleep(100);
    const t0 = performance.now();
    await openPath(big);
    await waitFor(() => ready(big), 15000);
    return { elements: session(big).api.getSceneElements().length, ms: Math.round(performance.now() - t0) };
  });

  await step("切回小图：内容和视口都还在", async () => {
    await activate(small);
    await waitFor(() => ready(small));
    await sleep(300);
    const a = session(small).api.getAppState();
    const ids = session(small).api.getSceneElements().map((e: any) => e.id);
    if (Math.abs(a.scrollX - 123) > 1 || Math.abs(a.zoom.value - 0.8) > 0.01) throw new Error(`视口 ${a.scrollX},${a.scrollY},${a.zoom.value}`);
    if (!ids.includes("local-dirty")) throw new Error("内容丢了");
    return { scrollX: a.scrollX, zoom: a.zoom.value, elements: ids.length };
  });

  await step("新建图", async () => {
    await newDoc();
    const p = getState().active!;
    await waitFor(() => ready(p));
    if (!p.startsWith(`${dir}/子文件夹/`)) throw new Error(`新图位置 ${p}`);
    await waitFor(() => JSON.stringify(getState().trees[dir]).includes("未命名"), 3000);
    return p;
  });

  await step("导出 PNG / SVG", async () => {
    await activate(small);
    await waitFor(() => ready(small));
    await exportActive("png", `${dir}/导出.png`);
    await exportActive("svg", `${dir}/导出.svg`);
    const png = await ipc.debugSize(`${dir}/导出.png`);
    const svg = await ipc.debugRead(`${dir}/导出.svg`);
    if (png < 1000 || !svg.includes("<svg")) throw new Error(`png ${png} 字节`);
    return { pngBytes: png, svgBytes: svg.length };
  });

  await step("关闭标签前保存", async () => {
    const s = session(small);
    const last = rect(0, 600, { id: "before-close" });
    s.api.updateScene({ elements: [...s.api.getSceneElementsIncludingDeleted(), last], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    await sleep(100);
    const dirty = s.isDirty();
    await closeTab(small);
    const ids = fileIds(await ipc.debugRead(small));
    if (!ids.includes("before-close")) throw new Error(`关闭时没保存 dirty=${dirty} lastSave=${JSON.stringify(s.lastSave)} sceneHas=${s.elements.some((e) => e.id === "before-close")}`);
    return { tabs: getState().tabs.length };
  });

  await step("保存出的文件是合法的 .excalidraw", async () => {
    const d = JSON.parse(await ipc.debugRead(small));
    const bad = (d.elements as any[]).filter((e) => !e.id || !e.type || typeof e.version !== "number" || !e.index);
    if (d.type !== "excalidraw" || d.version !== 2 || bad.length) throw new Error(`坏元素 ${bad.length}`);
    const idx = (d.elements as any[]).map((e) => e.index);
    if ([...idx].sort().join() !== idx.join()) throw new Error("元素没按 index 排序");
    return { elements: d.elements.length };
  });

  const out = { env: "selftest", at: new Date().toISOString(), dir, passed: steps.filter((s) => s.ok).length, total: steps.length, steps };
  await ipc.benchResult(JSON.stringify(out, null, 2));
}
