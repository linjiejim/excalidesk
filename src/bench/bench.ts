// P0 基准：同一份大图、同一个 1280×800 画布，在 Chrome / Safari / Tauri(60) / Tauri(120) 上各跑一遍。
// 交互全部走 Excalidraw 真实的事件入口（wheel / ctrl+wheel / pointer），帧间隔用 rAF 时间戳量。
import { getSceneVersion, restoreElements, serializeAsJSON, CaptureUpdateAction } from "@excalidraw/excalidraw";
import { ElementJsonCache, ezStyleSave, oursBody } from "./save";

type Api = any;
const isTauri = () => "__TAURI_INTERNALS__" in window;
const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
const frames = async (n: number) => { for (let i = 0; i < n; i++) await raf(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const median = (xs: number[]) => q(xs, 0.5);

let expected = 16.67;

function stats(ts: number[]) {
  const d = ts.slice(1).map((t, i) => t - ts[i]);
  const dur = ts[ts.length - 1] - ts[0];
  return {
    fps: r2((d.length / dur) * 1000), frames: d.length,
    p50: r2(q(d, 0.5)), p95: r2(q(d, 0.95)), p99: r2(q(d, 0.99)), max: r2(Math.max(...d)),
    jank: d.filter((x) => x > expected * 1.5).length,
    long50: d.filter((x) => x > 50).length,
  };
}

function measureFrames(ms: number, perFrame: (i: number, elapsed: number) => void) {
  return new Promise<ReturnType<typeof stats>>((resolve) => {
    const ts: number[] = [];
    let start = -1;
    const f = (t: number) => {
      if (start < 0) start = t;
      ts.push(t);
      perFrame(ts.length - 1, t - start);
      if (t - start < ms) requestAnimationFrame(f);
      else resolve(stats(ts));
    };
    requestAnimationFrame(f);
  });
}

const canvas = () => document.querySelector("canvas.excalidraw__canvas.interactive") as HTMLCanvasElement;
const center = () => { const r = canvas().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
const wheel = (dx: number, dy: number, ctrl = false) => {
  const c = center();
  canvas().dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, ctrlKey: ctrl, clientX: c.x, clientY: c.y, bubbles: true, cancelable: true }));
};
const pointer = (type: string, x: number, y: number, target: EventTarget = canvas()) =>
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true }));

async function loadScene(api: Api, text: string) {
  const t0 = performance.now();
  const data = JSON.parse(text);
  const elements = restoreElements(data.elements, null, { repairBindings: true });
  const t1 = performance.now();
  api.addFiles(Object.values(data.files ?? {}));
  api.updateScene({ elements, appState: { viewBackgroundColor: "#ffffff" }, captureUpdate: CaptureUpdateAction.NEVER });
  api.scrollToContent(elements, { fitToContent: true, animate: false });
  await frames(2);
  return { parseRestoreMs: r2(t1 - t0), totalMs: r2(performance.now() - t0) };
}

function touchOne(api: Api) {
  const els = api.getSceneElementsIncludingDeleted();
  const i = els.findIndex((e: any) => e.type === "rectangle");
  const next = els.slice();
  next[i] = { ...els[i], x: els[i].x + 1, version: els[i].version + 1, versionNonce: (Math.random() * 2 ** 31) | 0, updated: Date.now() };
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
}

async function tauriSave(bytes: Uint8Array) {
  const { invoke } = await import("@tauri-apps/api/core");
  const t0 = performance.now();
  const rustUs = await invoke<number>("save_doc", bytes, { headers: { path: "/tmp/p0-save-test.excalidraw" } });
  return { roundTripMs: r2(performance.now() - t0), rustWriteMs: r2(rustUs / 1000), bytes: bytes.length };
}

// 以第 3 列第 2 行 frame 的中心为视口中心
function setView(api: Api, zoom: number) {
  const W = 1280, H = 800, cx = 2 * 1400 + 600, cy = 1100 + 450;
  api.updateScene({ appState: { zoom: { value: zoom }, scrollX: W / 2 / zoom - cx, scrollY: H / 2 / zoom - cy }, captureUpdate: CaptureUpdateAction.NEVER });
}

export async function runBench(api: Api, env: string, status: (s: string) => void) {
  const out: any = {
    env, ua: navigator.userAgent, dpr: devicePixelRatio,
    canvas: { w: canvas()?.clientWidth, h: canvas()?.clientHeight }, at: new Date().toISOString(), tests: {},
  };
  const T = out.tests;
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    out.tauri = await invoke("opts");
  }
  await sleep(500);

  status("baseline rAF");
  T.baseline = await measureFrames(1500, () => {});
  expected = T.baseline.p50;

  status("open ×4");
  const text = await fetch("/scenes/large.excalidraw").then((r) => r.text());
  out.scene = { bytes: text.length };
  T.open = [];
  for (let i = 0; i < 4; i++) {
    api.resetScene();
    await frames(5);
    T.open.push(await loadScene(api, text));
    await sleep(300);
  }
  await document.fonts.ready;
  await sleep(800);
  out.scene.elements = api.getSceneElements().length;

  status("pan · fit（全图可见）");
  api.scrollToContent(api.getSceneElements(), { fitToContent: true, animate: false });
  await frames(10);
  T.panFit = await measureFrames(4000, (i) => wheel(Math.cos(i / 15) * 12, Math.sin(i / 15) * 12));

  status("zoom · ctrl+wheel");
  T.zoom = await measureFrames(4000, (i) => wheel(0, Math.sin(i / 10) * 8, true));

  status("pan · 30%（约 1/4 场景可见）");
  setView(api, 0.3);
  await frames(10);
  T.pan30 = await measureFrames(4000, (i) => wheel(Math.cos(i / 15) * 14, Math.sin(i / 15) * 14));

  status("pan · 100%");
  setView(api, 1);
  await frames(10);
  T.pan100 = await measureFrames(4000, (i) => wheel(Math.cos(i / 15) * 14, Math.sin(i / 15) * 14));

  status("freedraw · 全图可见，画在 frame 里");
  api.scrollToContent(api.getSceneElements(), { fitToContent: true, animate: false });
  api.setActiveTool({ type: "freedraw" });
  await frames(10);
  const before = api.getSceneElements().length;
  const c = center();
  pointer("pointerdown", c.x, c.y);
  T.freedraw = await measureFrames(3000, (i) => {
    const a = i / 6, rr = 20 + i * 0.4;
    pointer("pointermove", c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr);
  });
  pointer("pointerup", c.x, c.y, window);
  await frames(3);
  T.freedraw.created = api.getSceneElements().length - before;
  api.setActiveTool({ type: "selection" });

  status("save compute");
  const els = api.getSceneElementsIncludingDeleted();
  const st = api.getAppState();
  const files = api.getFiles();
  const cache = new ElementJsonCache();
  const S: any = (T.save = {});
  let t = performance.now(); for (let i = 0; i < 20; i++) getSceneVersion(els); S.sceneVersionMs = r2((performance.now() - t) / 20);
  t = performance.now(); oursBody(cache, els, st); S.oursColdMs = r2(performance.now() - t);
  const warm: number[] = [];
  for (let i = 0; i < 10; i++) { touchOne(api); const e2 = api.getSceneElementsIncludingDeleted(); const t0 = performance.now(); oursBody(cache, e2, st); warm.push(performance.now() - t0); }
  S.oursWarmMs = r2(median(warm)); S.oursWarmRestringified = cache.restringified;
  const naive: number[] = [];
  for (let i = 0; i < 5; i++) { const t0 = performance.now(); JSON.stringify(els); naive.push(performance.now() - t0); }
  S.naiveElementsStringifyMs = r2(median(naive));
  const naiveEnc: number[] = [];
  for (let i = 0; i < 5; i++) { const t0 = performance.now(); new TextEncoder().encode(`{"elements":${JSON.stringify(els)},"appState":{}}`); naiveEnc.push(performance.now() - t0); }
  S.naiveStringifyEncodeMs = r2(median(naiveEnc));
  const official: number[] = [];
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); serializeAsJSON(els, st, files, "local"); official.push(performance.now() - t0); }
  S.officialSerializeWithFilesMs = r2(median(official));
  const ez: any[] = [];
  for (let i = 0; i < 3; i++) ez.push(await ezStyleSave(els, st, files));
  S.ezStyle = { syncMs: r2(median(ez.map((x) => x.syncMs))), totalMs: r2(median(ez.map((x) => x.totalMs))), maxChunkMs: r2(median(ez.map((x) => x.maxChunkMs))), bytes: ez[0].bytes };
  if (isTauri()) {
    const body = oursBody(cache, api.getSceneElementsIncludingDeleted(), st);
    const ipc = [];
    for (let i = 0; i < 5; i++) ipc.push(await tauriSave(body));
    S.tauriIpcElements = { roundTripMs: r2(median(ipc.map((x) => x.roundTripMs))), rustWriteMs: r2(median(ipc.map((x) => x.rustWriteMs))), bytes: body.length };
    const full = new TextEncoder().encode(serializeAsJSON(els, st, files, "local"));
    const ipcFull = [];
    for (let i = 0; i < 3; i++) ipcFull.push(await tauriSave(full));
    S.tauriIpcWithFiles = { roundTripMs: r2(median(ipcFull.map((x) => x.roundTripMs))), rustWriteMs: r2(median(ipcFull.map((x) => x.rustWriteMs))), bytes: full.length };
  }

  for (const mode of ["ours", "ezStyle"] as const) {
    status(`pan@100% + 每 1.5s 保存一次（${mode}）`);
    setView(api, 1);
    await frames(10);
    const timers = [1500, 3000, 4500].map((ms) =>
      setTimeout(async () => {
        touchOne(api);
        const e2 = api.getSceneElementsIncludingDeleted();
        if (mode === "ours") {
          const body = oursBody(cache, e2, api.getAppState());
          if (isTauri()) await tauriSave(body);
        } else {
          await ezStyleSave(e2, api.getAppState(), api.getFiles());
        }
      }, ms),
    );
    T[`panWhileSaving_${mode}`] = await measureFrames(6000, (i) => wheel(Math.cos(i / 15) * 14, Math.sin(i / 15) * 14));
    timers.forEach(clearTimeout);
    await sleep(500);
  }

  const mem = (performance as any).memory;
  if (mem) out.jsHeapMB = r2(mem.usedJSHeapSize / 1e6);
  status("done");
  return out;
}

export async function postResults(env: string, out: unknown) {
  const json = JSON.stringify(out, null, 2);
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("bench_result", { json });
  }
  await fetch(`/__bench?env=${encodeURIComponent(env)}`, { method: "POST", body: json });
  return "posted";
}
