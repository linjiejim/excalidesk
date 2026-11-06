// 端到端自测（--selftest）：在临时工作区里把主路径和边界情况都走一遍，结果写到结果目录后退出。
// 移到废纸篓和 iCloud 冲突不在这里测：前者会动到真实的废纸篓，后者需要两台设备。
import { CaptureUpdateAction, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { activate, addRoot, closeTab, duplicatePath, exportActive, moveRoot, newDoc, newFolder, openPath, removeRoot, renamePath, sessions } from "./actions";
import { t } from "./i18n";
import { sortTree } from "./Shell";
import { ipc } from "./ipc";
import { getState, setState, updateSettings } from "./store";

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
const fileIds = (text: string) => (JSON.parse(text).elements as any[]).filter((e) => !e.isDeleted).map((e) => e.id);
const session = (p: string) => sessions.get(p)!;
const tabOf = (p: string) => getState().tabs.find((t) => t.path === p);
const ready = (p: string) => tabOf(p)?.phase === "ready" && !!sessions.get(p)?.api;
const exists = async (p: string) => (await ipc.debugSize(p)) > 0;
const treeText = (root: string) => JSON.stringify(getState().trees[root] ?? []);
/** 模拟用户在画布上的一次编辑（先触发「用户动过画布」，否则会被当成规整期里的自动变化） */
function edit(p: string, f: (els: any[]) => any[]) {
  const s = session(p);
  s.userInput();
  s.api.updateScene({ elements: f(s.api.getSceneElementsIncludingDeleted()), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

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
        detail: { error: String((e as Error)?.message ?? e), tabs: st.tabs.map((t) => [t.title, t.phase, t.save, t.banner, t.missing]), active: st.active?.split("/").pop(), pageErrors: [...pageErrors] },
      });
      pageErrors.length = 0;
    }
  };

  const dir = await ipc.realPath(await ipc.selftestDir());
  const big = `${dir}/大图.excalidraw`;
  let small = `${dir}/子文件夹/小图.excalidraw`;
  const skewed = `${dir}/文字尺寸不准.excalidraw`;
  const write = (p: string, scene: unknown) => ipc.writeBytes(p, new TextEncoder().encode(JSON.stringify(scene)));

  await step("准备工作区并扫描文件树", async () => {
    await ipc.writeBytes(big, new Uint8Array(await (await fetch("/scenes/large.excalidraw")).arrayBuffer()));
    await write(small, { type: "excalidraw", version: 2, elements: [rect(0, 0), rect(200, 0)], appState: {}, files: {} });
    const text = { id: "skewed-text", type: "text", x: 0, y: 0, width: 1, height: 1, text: "文字尺寸是错的 wrong size", originalText: "文字尺寸是错的 wrong size", fontSize: 28, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25, version: 1, versionNonce: 1, index: "a0" };
    await write(skewed, { type: "excalidraw", version: 2, elements: [text], appState: {}, files: {} });
    await addRoot(dir);
    for (const n of ["大图", "小图", "文字尺寸不准"]) if (!treeText(dir).includes(n)) throw new Error(`树里缺 ${n}`);
    return getState().trees[dir].map((n) => n.name);
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
    added = rect(400, 0);
    edit(small, (els) => [...els, added]);
    await waitFor(async () => fileIds(await ipc.debugRead(small)).includes(added.id), 5000);
    return session(small).lastSave;
  });

  await step("第二次编辑只发 1 个元素（增量）", async () => {
    edit(small, (els) => els.map((e) => (e.id === added.id ? { ...e, x: e.x + 50, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)));
    await waitFor(async () => (JSON.parse(await ipc.debugRead(small)).elements as any[]).find((e) => e.id === added.id)?.x === 450, 5000);
    const s = session(small);
    if (s.lastSave.full || s.lastSave.upserts !== 1) throw new Error(JSON.stringify(s.lastSave));
    return s.lastSave;
  });

  await step("外部修改（本地无改动）→ 自动载入", async () => {
    await ipc.externalEdit(small, rect(0, 300, { id: "external-clean" }));
    await waitFor(() => session(small).api.getSceneElements().some((e: any) => e.id === "external-clean"), 6000);
    return tabOf(small)?.banner;
  });

  await step("外部修改（本地有未保存改动）→ 按元素合并并保存", async () => {
    const s = session(small);
    s.debounceMs = 8000;
    s.maxWaitMs = 8000;
    edit(small, (els) => [...els, rect(200, 300, { id: "local-dirty" })]);
    await sleep(50);
    if (!s.isDirty()) throw new Error("本地应为未保存状态");
    await ipc.externalEdit(small, rect(400, 300, { id: "external-dirty" }));
    await waitFor(async () => {
      const ids = fileIds(await ipc.debugRead(small));
      return ids.includes("local-dirty") && ids.includes("external-dirty") && ids.includes("external-clean");
    }, 8000);
    s.debounceMs = 800;
    s.maxWaitMs = 5000;
    return tabOf(small)?.banner;
  });

  await step("打开文件后 Excalidraw 自己的规整不写盘", async () => {
    session(small).api.updateScene({ appState: { scrollX: 123, scrollY: 45, zoom: { value: 0.8 } }, captureUpdate: CaptureUpdateAction.NEVER });
    await sleep(100);
    const before = await ipc.debugRead(skewed);
    await openPath(skewed);
    await waitFor(() => ready(skewed));
    await sleep(4500);
    const after = await ipc.debugRead(skewed);
    const s = session(skewed);
    // 确认规整真的发生了：文件里没有 gridStep，Excalidraw 挂载后会补上默认值
    const gridStep = s.api.getAppState().gridStep;
    if (JSON.parse(before).appState.gridStep !== undefined || !gridStep) throw new Error("没有发生规整，这一步无效");
    if (after !== before || s.saves !== 0) throw new Error(`文件被改写了（保存 ${s.saves} 次）`);
    return { save: tabOf(skewed)?.save, saves: s.saves, gridStep };
  });

  await step("用户真正编辑后保存（连同规整后的 appState）", async () => {
    edit(skewed, (els) => [...els, rect(0, 200, { id: "after-settle" })]);
    await waitFor(async () => fileIds(await ipc.debugRead(skewed)).includes("after-settle"), 5000);
    const st = JSON.parse(await ipc.debugRead(skewed)).appState;
    if (!st.gridStep) throw new Error(`appState ${JSON.stringify(st)}`);
    return st;
  });

  await step("打开 3000 元素大图", async () => {
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

  await step("重命名打开中的文件：标签跟着走，继续编辑存到新路径", async () => {
    await activate(small);
    await waitFor(() => ready(small));
    const old = small;
    await renamePath(old, "改过名的小图");
    small = `${dir}/子文件夹/改过名的小图.excalidraw`;
    if (!tabOf(small) || getState().active !== small) throw new Error("标签没跟着改名");
    if (await exists(old)) throw new Error("旧文件还在");
    await waitFor(() => treeText(dir).includes("改过名的小图"), 3000);
    edit(small, (els) => [...els, rect(600, 600, { id: "after-rename" })]);
    await waitFor(async () => fileIds(await ipc.debugRead(small)).includes("after-rename"), 5000);
    return small.split("/").pop();
  });

  await step("创建副本", async () => {
    await duplicatePath(small);
    const copy = `${dir}/子文件夹/改过名的小图 ${t("app.copySuffix")}.excalidraw`;
    await waitFor(() => exists(copy), 3000);
    if (!fileIds(await ipc.debugRead(copy)).includes("after-rename")) throw new Error("副本内容不对");
    return copy.split("/").pop();
  });

  await step("新建文件夹并在里面新建图", async () => {
    await newFolder(dir);
    const folder = getState().renaming!;
    setState({ renaming: null });
    if (!folder?.endsWith(t("app.newFolder"))) throw new Error(`文件夹 ${folder}`);
    await waitFor(() => treeText(dir).includes(t("app.newFolder")), 3000);
    await newDoc(folder);
    const p = getState().active!;
    await waitFor(() => ready(p));
    if (!p.startsWith(folder + "/")) throw new Error(`新图位置 ${p}`);
    await closeTab(p);
    return p.split("/").slice(-2).join("/");
  });

  await step("历史版本：自动留档并能恢复", async () => {
    await activate(small);
    await waitFor(() => ready(small));
    const list = await ipc.historyList(small);
    if (!list.length) throw new Error("没有历史版本");
    const oldest = list[list.length - 1];
    const snapIds = fileIds(await ipc.historyRead(small, oldest.id));
    await session(small).restoreHistory(oldest.id);
    const now = session(small).api.getSceneElements().map((e: any) => e.id).sort();
    if (JSON.stringify(now) !== JSON.stringify([...snapIds].sort())) throw new Error(`画布 ${now.length} 个，快照 ${snapIds.length} 个`);
    await waitFor(async () => JSON.stringify(fileIds(await ipc.debugRead(small)).sort()) === JSON.stringify([...snapIds].sort()), 5000);
    const after = await ipc.historyList(small);
    if (!after.some((e) => e.reason === "before_restore")) throw new Error("恢复前没留档");
    return { versions: list.map((e) => e.reason), restored: snapIds.length };
  });

  await step("文件在外部被删除：暂停保存、不复活，可存回原位置", async () => {
    const copy = `${dir}/子文件夹/改过名的小图 ${t("app.copySuffix")}.excalidraw`;
    await openPath(copy);
    await waitFor(() => ready(copy));
    await ipc.debugRemove(copy);
    await waitFor(() => tabOf(copy)?.missing, 5000);
    edit(copy, (els) => [...els, rect(0, 900, { id: "while-missing" })]);
    await sleep(2000);
    if (await exists(copy)) throw new Error("被删掉的文件被写回来了");
    await session(copy).restoreAtPath();
    await waitFor(async () => (await exists(copy)) && fileIds(await ipc.debugRead(copy)).includes("while-missing"), 5000);
    if (tabOf(copy)?.missing) throw new Error("标签还标着丢失");
    await closeTab(copy);
    return "ok";
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
    edit(small, (els) => [...els, rect(0, 600, { id: "before-close" })]);
    await sleep(100);
    await closeTab(small);
    if (!fileIds(await ipc.debugRead(small)).includes("before-close")) throw new Error("关闭时没保存");
    return { tabs: getState().tabs.length };
  });

  await step("拖动调整工作区顺序（持久化）", async () => {
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    const second = await ipc.mkdir(parent, `${dir.split("/").pop()}-second`);
    await addRoot(second);
    await moveRoot(second, dir, false);
    const roots = (await ipc.state()).roots;
    const ok = roots.indexOf(second) === roots.indexOf(dir) - 1;
    await removeRoot(second);
    if (!ok) throw new Error(JSON.stringify(roots.map((r) => r.split("/").pop())));
    return "ok";
  });

  await step("侧边栏排序：最新修改在上、文件夹在前、名称排序", async () => {
    const f = (name: string, mtime: number, ctime = 0) => ({ name, path: name, dir: false, mtime, ctime, dataless: false });
    const nodes = [f("b", 1), f("a", 3), { name: "d", path: "d", dir: true, mtime: 0, ctime: 0, dataless: false, children: [f("x", 2)] }];
    const byTime = sortTree(nodes, "mtime", "zh").map((n) => n.name).join();
    const byName = sortTree(nodes, "name", "zh").map((n) => n.name).join();
    if (byTime !== "d,a,b" || byName !== "d,a,b".split(",").sort((a, b) => (a === "d" ? -1 : b === "d" ? 1 : a.localeCompare(b))).join()) throw new Error(`${byTime} / ${byName}`);
    return { byTime, byName };
  });

  await step("中英切换", async () => {
    updateSettings({ lang: "en" });
    const en = t("status.opened");
    updateSettings({ lang: "zh" });
    const zh = t("status.opened");
    updateSettings({ lang: "system" });
    if (en !== "Opened" || zh !== "已打开") throw new Error(`${en} / ${zh}`);
    return { en, zh };
  });

  await step("最近打开里不存在的文件会被清掉", async () => {
    const gone = `${dir}/会被删掉.excalidraw`;
    await write(gone, { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });
    await openPath(gone);
    await waitFor(() => ready(gone));
    await closeTab(gone);
    await ipc.debugRemove(gone);
    const recent = (await ipc.state()).recent;
    if (recent.includes(gone)) throw new Error("还在最近打开里");
    return "ok";
  });

  await step("保存出的文件是合法的 .excalidraw", async () => {
    const d = JSON.parse(await ipc.debugRead(small));
    const bad = (d.elements as any[]).filter((e) => !e.id || !e.type || typeof e.version !== "number" || !e.index);
    if (d.type !== "excalidraw" || d.version !== 2 || bad.length) throw new Error(`坏元素 ${bad.length}`);
    const idx = (d.elements as any[]).map((e) => e.index);
    if ([...idx].sort().join() !== idx.join()) throw new Error("元素没按 index 排序");
    return { elements: d.elements.length };
  });

  const out = { env: "selftest", at: new Date().toISOString(), navigatorLanguage: navigator.language, passed: steps.filter((s) => s.ok).length, total: steps.length, steps };
  await ipc.benchResult(JSON.stringify(out, null, 2));
}
