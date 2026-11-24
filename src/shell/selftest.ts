// 端到端自测（--selftest）：在临时工作区里把主路径和边界情况都走一遍，结果写到结果目录后退出。
// 移到废纸篓和 iCloud 冲突不在这里测：前者会动到真实的废纸篓，后者需要两台设备。
import { CaptureUpdateAction, convertToExcalidrawElements, restoreElements } from "@excalidraw/excalidraw";
import { activate, addRoot, closeTab, duplicatePath, exportActive, moveRoot, newDoc, newFolder, openPath, removeRoot, renamePath, sessions } from "./actions";
import { t } from "./i18n";
import { sortTree } from "./Shell";
import { ipc } from "./ipc";
import { getState, setState, updateSettings } from "./store";
import { startPresentation } from "./present";
import { exportPdf, renderPdf } from "./pdf";
import { addNotes, buildFrame, newSlide, slidesOf } from "./slides";
import { hitOutline } from "./convert";
import { commitComment, editComment, runOp } from "./agent";
import { toggleNotes } from "./NotesLayer";

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

  // 演示（docs/specs/20261117-presentation-mode.md）：两页一行 + 第二行一页，第一页下面有备注
  const deck = `${dir}/演示.excalidraw`;
  const key = (k: string, code = k) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true }));
  await step("演示：先行后列地翻页、遮罩、备注、退出后原样恢复", async () => {
    const a = buildFrame({ x: 0, y: 0, w: 1920, h: 1080 }, "A", { slide: true });
    const b = buildFrame({ x: 2080, y: 0, w: 1920, h: 1080 }, "B");
    const c = buildFrame({ x: 0, y: 2000, w: 1920, h: 1080 }, "C");
    const n = buildFrame({ x: 0, y: 1160, w: 1920, h: 480 }, "Notes", { notesFor: a.id });
    const note = convertToExcalidrawElements([{ type: "text", x: 40, y: 1200, text: "note one" } as any], { regenerateIds: false })[0] as any;
    await write(deck, { type: "excalidraw", version: 2, elements: [b, c, a, n, { ...note, frameId: n.id }, { ...rect(100, 100), frameId: a.id }], appState: {}, files: {} });
    await openPath(deck);
    await waitFor(() => ready(deck));
    const api = session(deck).api;
    await sleep(300);
    // 进入前选中一页（选择工具），退出后选择要回来（矩形等工具本身会清空选择，工具另外测）
    api.updateScene({ appState: { selectedElementIds: { [b.id]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
    await sleep(100);
    const before = api.getAppState();
    startPresentation(true);
    await waitFor(() => getState().presenting?.index === 0 && api.getAppState().viewModeEnabled);
    const p0 = getState().presenting!;
    if (p0.total !== 3 || p0.notesText !== "note one") throw new Error(`total ${p0.total} notes ${p0.notesText}`);
    const fr = api.getAppState().frameRendering;
    if (fr.name || fr.outline || !fr.clip) throw new Error(`frameRendering ${JSON.stringify(fr)}`);
    // 进全屏要有权限（core:window:allow-set-fullscreen）
    const full = await waitFor(() => getState().fullscreen, 6000).catch(() => false);
    await waitFor(() => (document.querySelector<HTMLElement>(".present-mask")?.offsetWidth ?? 0) > 100);
    const order: string[] = [];
    const at = () => slidesOf(api.getSceneElements())[getState().presenting!.index].frame.name;
    order.push(at());
    key("ArrowRight");
    await waitFor(() => getState().presenting?.index === 1);
    order.push(at());
    key(" ", "Space");
    await waitFor(() => getState().presenting?.index === 2);
    order.push(at());
    key("Home");
    await waitFor(() => getState().presenting?.index === 0);
    if (order.join() !== "A,B,C") throw new Error(`顺序 ${order}`);
    // 页铺满一个方向（不是 0.1 一档的缩放）
    await sleep(500);
    const st = api.getAppState();
    const fill = Math.max((1920 * st.zoom.value) / st.width, (1080 * st.zoom.value) / st.height);
    if (Math.abs(fill - 1) > 0.01) throw new Error(`铺满比例 ${fill}`);
    key("Escape");
    await waitFor(() => !getState().presenting);
    await sleep(200);
    const after = api.getAppState();
    const same = ["viewModeEnabled", "zenModeEnabled", "scrollX", "scrollY"].every((k) => after[k] === before[k]) && after.zoom.value === before.zoom.value && after.frameRendering.name === before.frameRendering.name
      && after.selectedElementIds[b.id] === true;
    if (!same) throw new Error(`没恢复 ${JSON.stringify({ before: [before.scrollX, before.zoom.value, before.viewModeEnabled], after: [after.scrollX, after.zoom.value, after.viewModeEnabled, Object.keys(after.selectedElementIds), after.activeTool.type] })}`);
    // 记下的视口是放映前的镜头，不是某一页的
    const vp = getState().viewports[deck];
    if (vp && (vp.zoom !== before.zoom.value || vp.scrollX !== before.scrollX)) throw new Error(`视口记成了放映时的 ${JSON.stringify(vp)}`);
    // 等第一次退出全屏做完，再测：用矩形工具时开始放映，退出后还是矩形工具
    if (full) await waitFor(() => !getState().fullscreen, 6000);
    await sleep(800);
    api.setActiveTool({ type: "rectangle" });
    await sleep(100);
    startPresentation(true);
    await waitFor(() => getState().presenting?.index === 0);
    await sleep(300);
    key("Escape");
    await waitFor(() => !getState().presenting);
    await sleep(200);
    const tool = api.getAppState().activeTool.type;
    api.setActiveTool({ type: "selection" });
    if (tool !== "rectangle") throw new Error(`工具没恢复：${tool}`);
    if (full) await waitFor(() => !getState().fullscreen, 8000);
    if (tabOf(deck)?.save !== "saved") throw new Error(`放映把文件标脏了：${tabOf(deck)?.save}`);
    if (!full) throw new Error("没有进全屏");
    return { order, fill: Number(fill.toFixed(3)), fullscreen: full };
  });

  // 和 Rust（mcp/scene.rs 的测试）同一组用例：两边规则不能分叉
  await step("演示：排序和备注配对（和 Rust 同一组用例）", async () => {
    const fr = (id: string, name: string, x: number, y: number, w: number, h: number, ex?: Record<string, unknown>) => ({ ...buildFrame({ x, y, w, h }, name, ex), id });
    const txt = (id: string, frameId: string, y: number, text: string) => ({ ...(convertToExcalidrawElements([{ type: "text", x: 0, y, text } as any], { regenerateIds: false })[0] as any), id, frameId });
    const ids = (els: any[]) => slidesOf(els).map((x) => x.frame.id).join();
    const rows = ids([fr("c", "C", 0, 2000, 1920, 1080), fr("b", "B", 2080, 100, 1920, 800), fr("a", "A", 0, 0, 1920, 1080)]);
    if (rows !== "a,b,c") throw new Error(`先行后列 ${rows}`);
    const els = [
      fr("a", "A", 0, 0, 1920, 1080), fr("b", "B", 2080, 0, 1920, 1080), fr("c", "C", 4160, 0, 1920, 1080),
      fr("n1", "Notes", 0, 1160, 1920, 480, { notesFor: "a" }), fr("n2", "Notes", 2080, 1160, 1920, 480, { notesFor: "a" }),
      fr("n3", "备注", 9000, 5000, 1920, 480, { notesFor: "c" }), fr("hand", "备注 · 第二页", 2100, 1300, 1800, 300),
      txt("t1", "n1", 1200, "first"), txt("t3", "n2", 1300, "second, lower"), txt("t2", "n2", 1200, "second"), txt("t4", "n3", 5100, "third"), txt("t5", "hand", 1350, "by hand"),
    ];
    const sl = slidesOf(els);
    const notes = sl.map((x) => x.notesText);
    if (sl.map((x) => x.frame.id).join() !== "a,b,c" || notes[0] !== "first" || notes[1] !== "second\n\nsecond, lower\n\nby hand" || notes[2] !== "third") throw new Error(`配对 ${JSON.stringify(notes)}`);
    const named = ids([
      fr("f", "Notes & references", 0, 0, 1920, 1080, { slide: true }), fr("g", "备注", 2080, 0, 1920, 1080, { slide: true }),
      fr("app", "Notes app redesign", 4160, 0, 1920, 1080), fr("n1", "notes: intro", 0, 1160, 1920, 400), fr("n2", "备注（第二页）", 2080, 1160, 1920, 400),
    ]);
    if (named !== "f,g,app") throw new Error(`名字规则 ${named}`);
    return { rows, notes, named };
  });

  await step("演示：新建一页、添加备注", async () => {
    const s = session(deck);
    const api = s.api;
    api.updateScene({ appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
    s.userInput();
    newSlide(s);
    await sleep(200);
    const slides = slidesOf(api.getSceneElements());
    const made = slides.find((x) => x.frame.name === "第 4 页" || x.frame.name === "Slide 4");
    // 最后一行（第二行只有 C）最后一页的右边
    if (!made || made.frame.x !== 1920 + 160 || made.frame.y !== 2000 || made.frame.width !== 1920 || !made.frame.customData?.excalidesk?.slide) throw new Error(`新页 ${JSON.stringify(made?.frame && [made.frame.name, made.frame.x, made.frame.y])}`);
    // 新页是选中的：给它加备注
    addNotes(s);
    await sleep(200);
    const again = slidesOf(api.getSceneElements()).find((x) => x.frame.id === made.frame.id)!;
    if (again.notes.length !== 1 || again.notes[0].y !== 2000 + 1080 + 80) throw new Error(`备注 ${again.notes.length}`);
    return { order: slidesOf(api.getSceneElements()).map((x) => x.frame.name), notes: again.notesText };
  });

  await step("导出 PDF：一页一张、按放映顺序、写盘", async () => {
    const api = session(deck).api;
    const { bytes, pages } = await renderPdf(api, "演示");
    const text = new TextDecoder("latin1").decode(bytes);
    const xrefAt = Number(text.match(/startxref\n(\d+)/)?.[1]);
    const lines = text.slice(xrefAt).split("\n");
    const size = Number(lines[1].split(" ")[1]);
    const bad: number[] = [];
    for (let id = 1; id < size; id++) if (!text.startsWith(`${id} 0 obj`, Number(lines[2 + id].slice(0, 10)))) bad.push(id);
    const boxes = [...text.matchAll(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => `${m[1]}x${m[2]}`);
    if (pages !== 4 || bad.length || !text.startsWith("%PDF-1.4") || boxes.some((b) => b !== "1920x1080")) throw new Error(JSON.stringify({ pages, bad, boxes }));
    const target = `${dir}/演示.pdf`;
    await activate(deck);
    await exportPdf(target);
    const written = await ipc.debugSize(target);
    if (written < 1000) throw new Error(`写盘只有 ${written} 字节`);
    return { pages, bytes: bytes.length };
  });

  // 转换形状（docs/specs/20261123-convert-shapes.md）：按键发给 .excalidraw，和用户在画布上按一样先经过 Editor 的 onKeyDownCapture
  const shapes = `${dir}/形状转换.excalidraw`;
  const hk = (k: string, code: string, mods: KeyboardEventInit = {}, target?: Element | null) =>
    (target ?? document.querySelector(".excalidraw"))!.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true, ...mods }));
  const undo = () => hk("z", "KeyZ", { metaKey: true });
  const sapi = () => session(shapes).api;
  const pick = async (...ids: string[]) => {
    sapi().updateScene({ appState: { selectedElementIds: Object.fromEntries(ids.map((i) => [i, true])) }, captureUpdate: CaptureUpdateAction.NEVER });
    await sleep(80);
  };
  const get = (id: string) => (sapi().getSceneElementsIncludingDeleted() as any[]).find((e) => e.id === id);
  const labelOf = (c: any) => get(c.boundElements.find((b: any) => b.type === "text").id);
  const popup = () => document.querySelector(".xd-convert");
  const listText = "机器\n\nJim Pro\n- 个人工作站\n\nJimmyhome\n- 个人项目\n- 个人 agent";
  /** 文字框四个角都在形状里面（矩形按外框，菱形 / 椭圆按轮廓） */
  const inside = (t: any, c: any) => {
    const a = c.width / 2, b = c.height / 2, cx = c.x + a, cy = c.y + b;
    return [[t.x, t.y], [t.x + t.width, t.y], [t.x, t.y + t.height], [t.x + t.width, t.y + t.height]].every(([x, y]) => {
      const dx = Math.abs(x - cx) / a, dy = Math.abs(y - cy) / b;
      return c.type === "ellipse" ? dx * dx + dy * dy <= 1.001 : c.type === "diamond" ? dx + dy <= 1.001 : dx <= 1.001 && dy <= 1.001;
    });
  };
  /** 撤销转换后：删掉的容器不再登记这段文字，重新打开（restoreElements 修绑定）时文字也不会被绑回去 */
  const cleanAfterUndo = (textId: string, containerId: string) => {
    const c = get(containerId);
    if (c && c.boundElements?.some((b: any) => b.id === textId)) throw new Error(`删掉的容器还登记着文字 ${JSON.stringify(c.boundElements)}`);
    const reopened = (restoreElements(sapi().getSceneElementsIncludingDeleted(), null, { repairBindings: true }) as any[]).find((e) => e.id === textId);
    if (reopened?.containerId) throw new Error(`重新打开后文字被绑回 ${reopened.containerId}`);
  };
  /** 箭头末端到连着的元素轮廓的距离（沿最后一段的方向） */
  const endGap = (a: any, target: any) => {
    const [px, py] = a.points.at(-2), [ex, ey] = a.points.at(-1);
    const len = Math.hypot(ex - px, ey - py);
    return hitOutline(target, { x: a.x + ex, y: a.y + ey }, { x: (ex - px) / len, y: (ey - py) / len });
  };

  await step("转换形状：准备", async () => {
    const els = convertToExcalidrawElements([
      { type: "text", id: "cv-list", x: 0, y: 0, text: listText, fontSize: 20, textAlign: "left" },
      { type: "rectangle", id: "cv-box", x: 400, y: 0, width: 200, height: 70, label: { text: "一段比较长的标签文字 long label" } },
      { type: "arrow", id: "cv-arrow", x: 760, y: 220, points: [[0, 0], [-170, -160]], end: { id: "cv-box" } },
      { type: "rectangle", id: "cv-empty", x: 400, y: 300, width: 140, height: 80 },
      { type: "text", id: "cv-word", x: 0, y: 320, text: "single", fontSize: 20 },
      { type: "arrow", id: "cv-arrow2", x: 200, y: 420, points: [[0, 0], [-120, -80]], end: { id: "cv-word" } },
      { type: "text", id: "cv-edit", x: 0, y: 520, text: "edit me", fontSize: 20 },
    ] as any, { regenerateIds: false });
    await write(shapes, { type: "excalidraw", version: 2, elements: els, appState: {}, files: {} });
    await openPath(shapes);
    await waitFor(() => ready(shapes));
    await sleep(600);
    session(shapes).userInput();
    if (get("cv-arrow")?.endBinding?.elementId !== "cv-box" || get("cv-arrow2")?.endBinding?.elementId !== "cv-word") throw new Error("箭头没连上");
    return els.length;
  });

  await step("转换形状：文本 ⇧R → 矩形，保留左对齐、不多换行、id 不变，⌘Z 一步撤销", async () => {
    const t0 = get("cv-list");
    await pick("cv-list");
    hk("R", "KeyR", { shiftKey: true });
    await sleep(120);
    const t = get("cv-list"), c = t.containerId && get(t.containerId);
    if (!c || c.type !== "rectangle" || c.isDeleted) throw new Error(`没有矩形 ${JSON.stringify([t.containerId, c?.type])}`);
    if (t.textAlign !== "left" || t.fontSize !== t0.fontSize) throw new Error(`对齐 / 字号变了 ${t.textAlign} ${t.fontSize}`);
    if (t.text.split("\n").length !== listText.split("\n").length) throw new Error(`多了换行 ${JSON.stringify(t.text)}`);
    if (Math.abs(t.x - t0.x) > 0.5 || Math.abs(t.y - t0.y) > 0.5) throw new Error(`文字挪了 ${[t0.x, t0.y]} → ${[t.x, t.y]}`);
    if (!inside(t, c)) throw new Error("文字跑到矩形外面");
    if (!sapi().getAppState().selectedElementIds[c.id]) throw new Error("没选中新矩形");
    undo();
    await sleep(150);
    if (get("cv-list").containerId || !get(c.id).isDeleted) throw new Error("⌘Z 没回到原样");
    cleanAfterUndo("cv-list", c.id);
    return { container: [c.width, c.height], lines: t.text.split("\n").length };
  });

  await step("转换形状：文本 ⇧D / ⇧O → 菱形 / 椭圆，文字完整地在里面", async () => {
    const out: Record<string, number[]> = {};
    for (const [type, code] of [["diamond", "KeyD"], ["ellipse", "KeyO"]]) {
      await pick("cv-list");
      hk(code.slice(3), code, { shiftKey: true });
      await sleep(120);
      const t = get("cv-list"), c = t.containerId && get(t.containerId);
      if (!c || c.type !== type) throw new Error(`没有${type} ${c?.type}`);
      if (t.text.split("\n").length !== listText.split("\n").length || !inside(t, c)) throw new Error(`${type} 里的文字 ${JSON.stringify(t.text)} ${[t.x, t.y, t.width, t.height]} / ${[c.x, c.y, c.width, c.height]}`);
      out[type] = [c.width, c.height];
      undo();
      await sleep(150);
      if (get("cv-list").containerId) throw new Error(`${type} 没撤销回去`);
    }
    return out;
  });

  await step("转换形状：带文字的矩形 ⇧D → 菱形，同一个 id、x / y / 宽不变，放不下撑高、字号不变", async () => {
    const b0 = get("cv-box"), l0 = labelOf(b0);
    await pick("cv-box");
    hk("D", "KeyD", { shiftKey: true });
    await sleep(120);
    const b = get("cv-box"), l = labelOf(b);
    if (b.type !== "diamond" || b.x !== b0.x || b.y !== b0.y || b.width !== b0.width) throw new Error(`菱形 ${JSON.stringify([b.type, b.x, b.y, b.width])}`);
    if (!(b.height > b0.height)) throw new Error(`没撑高 ${b0.height} → ${b.height}`);
    if (l.id !== l0.id || l.fontSize !== l0.fontSize || l.containerId !== b.id || !inside(l, b)) throw new Error(`标签 ${JSON.stringify([l.fontSize, l.containerId, l.x, l.y, l.width, l.height])}`);
    undo();
    await sleep(150);
    if (get("cv-box").type !== "rectangle" || get("cv-box").height !== b0.height) throw new Error("没撤销回去");
    return { height: [b0.height, b.height] };
  });

  await step("转换形状：箭头跟着走（矩形 → 椭圆贴着新轮廓；文本 → 形状改连容器）", async () => {
    await pick("cv-box");
    hk("O", "KeyO", { shiftKey: true });
    await sleep(120);
    const a = get("cv-arrow"), b = get("cv-box");
    const gap = a.endBinding?.gap ?? 5, d = endGap(a, b);
    if (b.type !== "ellipse" || a.endBinding?.elementId !== "cv-box") throw new Error(`绑定 ${a.endBinding?.elementId} ${b.type}`);
    if (d === null || Math.abs(d - gap) > 2) throw new Error(`端点离椭圆 ${d}，gap ${gap}`);
    undo();
    await sleep(150);
    await pick("cv-word");
    hk("R", "KeyR", { shiftKey: true });
    await sleep(120);
    const w = get("cv-word"), c = get(w.containerId), a2 = get("cv-arrow2");
    if (a2.endBinding?.elementId !== c.id || !c.boundElements.some((x: any) => x.id === "cv-arrow2")) throw new Error(`没改连容器 ${a2.endBinding?.elementId}`);
    const d2 = endGap(a2, c);
    if (d2 === null || Math.abs(d2 - (a2.endBinding.gap ?? 5)) > 2) throw new Error(`端点离容器 ${d2}`);
    undo();
    await sleep(150);
    if (get("cv-arrow2").endBinding?.elementId !== "cv-word") throw new Error("撤销后没连回文字");
    return { ellipse: d, container: d2 };
  });

  await step("转换形状：带文字的形状 ⇧T → 文本；没有文字的形状 ⇧T 不变、浮层里「文本」是灰的", async () => {
    const l0 = labelOf(get("cv-box"));
    await pick("cv-box");
    hk("T", "KeyT", { shiftKey: true });
    await sleep(120);
    const l = get(l0.id), a = get("cv-arrow");
    if (!get("cv-box").isDeleted || l.containerId || l.text !== l0.originalText) throw new Error(`文本 ${JSON.stringify([get("cv-box").isDeleted, l.containerId, l.text])}`);
    if (l.y !== l0.y || Math.abs(l.x + l.width / 2 - (l0.x + l0.width / 2)) > 0.5) throw new Error("居中的文字没留在原位");
    if (a.endBinding?.elementId !== l.id) throw new Error(`箭头没改连文字 ${a.endBinding?.elementId}`);
    undo();
    await sleep(150);
    if (get("cv-box").isDeleted || get(l0.id).containerId !== "cv-box") throw new Error("没撤销回去");
    const v = get("cv-empty").version;
    await pick("cv-empty");
    hk("T", "KeyT", { shiftKey: true });
    await sleep(100);
    if (get("cv-empty").version !== v) throw new Error("没文字的形状被改了");
    hk("Tab", "Tab");
    await waitFor(() => popup(), 2000);
    const disabled = document.querySelector<HTMLButtonElement>('.xd-convert__item[data-target="text"]')?.disabled;
    hk("Escape", "Escape");
    await sleep(100);
    if (!disabled || popup()) throw new Error(`文本项 disabled=${disabled}`);
    return "ok";
  });

  await step("转换形状：Tab 弹出不改图，Tab 下一种、⇧Tab 上一种，Esc 保留，整轮一步撤销", async () => {
    await pick("cv-word");
    const kind = () => {
      const w = get("cv-word");
      return w.containerId ? get(w.containerId).type : "text";
    };
    const seen: string[] = [];
    hk("Tab", "Tab");
    await sleep(100);
    if (!popup() || kind() !== "text") throw new Error(`第一下 Tab ${!!popup()} ${kind()}`);
    for (const shift of [false, false, true]) {
      hk("Tab", "Tab", { shiftKey: shift });
      await sleep(100);
      seen.push(kind());
    }
    if (seen.join() !== "rectangle,diamond,rectangle") throw new Error(`循环 ${seen}`);
    hk("Escape", "Escape");
    await sleep(120);
    if (popup() || kind() !== "rectangle") throw new Error(`Esc 后 ${!!popup()} ${kind()}`);
    const made = get("cv-word").containerId;
    undo();
    await sleep(150);
    if (kind() !== "text") throw new Error(`一次 ⌘Z 后是 ${kind()}`);
    cleanAfterUndo("cv-word", made);
    return seen;
  });

  await step("转换形状：Actions 栏按钮；只选箭头时没有按钮，Tab、⇧R 不改图", async () => {
    await pick("cv-empty");
    const trig = await waitFor(() => document.querySelector<HTMLButtonElement>(".selected-shape-actions fieldset .xd-convert-trigger"), 3000);
    trig!.click();
    await waitFor(() => popup(), 2000);
    document.querySelector<HTMLButtonElement>('.xd-convert__item[data-target="ellipse"]')!.click();
    await sleep(120);
    if (get("cv-empty").type !== "ellipse" || popup()) throw new Error(`按钮转换 ${get("cv-empty").type}`);
    undo();
    await sleep(150);
    const v = get("cv-arrow").version;
    await pick("cv-arrow");
    await sleep(150);
    if (document.querySelector(".xd-convert-trigger")) throw new Error("只选箭头时还有按钮");
    hk("Tab", "Tab");
    hk("R", "KeyR", { shiftKey: true });
    await sleep(100);
    if (popup() || get("cv-arrow").version !== v || get("cv-arrow").type !== "arrow") throw new Error("箭头被转换了");
    return "ok";
  });

  await step("转换形状：编辑文字时 Tab、⇧R 是正常输入", async () => {
    await pick("cv-edit");
    hk("Enter", "Enter");
    const ta = await waitFor(() => document.querySelector<HTMLTextAreaElement>("textarea.excalidraw-wysiwyg"), 3000);
    hk("R", "KeyR", { shiftKey: true }, ta);
    hk("Tab", "Tab", {}, ta);
    await sleep(100);
    const bad = popup() || get("cv-edit").containerId;
    hk("Escape", "Escape", {}, ta);
    await waitFor(() => !sapi().getAppState().editingTextElement, 3000);
    if (bad) throw new Error("编辑文字时触发了转换");
    return "ok";
  });

  await step("转换形状：选着的箭头还选着；再点按钮收起保留结果；浮层开着时别人改了就作废", async () => {
    await pick("cv-empty", "cv-arrow");
    hk("D", "KeyD", { shiftKey: true });
    await sleep(120);
    const sel = sapi().getAppState().selectedElementIds;
    if (get("cv-empty").type !== "diamond" || !sel["cv-arrow"] || !sel["cv-empty"]) throw new Error(`选择 ${Object.keys(sel)}`);
    undo();
    await sleep(150);
    await pick("cv-empty");
    const trig = await waitFor(() => document.querySelector<HTMLButtonElement>(".xd-convert-trigger"), 3000);
    trig!.click();
    await waitFor(() => popup(), 2000);
    hk("Tab", "Tab");
    await sleep(100);
    document.querySelector<HTMLButtonElement>(".xd-convert-trigger")!.click();
    await sleep(120);
    if (popup() || get("cv-empty").type !== "diamond") throw new Error(`再点按钮后 ${!!popup()} ${get("cv-empty").type}`);
    undo();
    await sleep(150);
    if (get("cv-empty").type !== "rectangle") throw new Error("没撤销回去");
    // Tab 切过之后点按钮：先收起 Tab 这一轮（保留结果），再打开按钮的浮层
    await pick("cv-empty");
    hk("Tab", "Tab");
    await sleep(80);
    hk("Tab", "Tab");
    await sleep(100);
    document.querySelector<HTMLButtonElement>(".xd-convert-trigger")!.click();
    await sleep(150);
    if (!popup() || get("cv-empty").type !== "diamond") throw new Error(`Tab 后点按钮 ${!!popup()} ${get("cv-empty").type}`);
    hk("Escape", "Escape");
    await sleep(100);
    undo();
    await sleep(150);
    if (get("cv-empty").type !== "rectangle") throw new Error("Tab 后点按钮：没撤销回去");
    // 别人（这里模拟 Agent）在循环中改了文字：浮层收起，别人的修改留着，不被开始前的快照盖回去
    await pick("cv-word");
    hk("Tab", "Tab");
    await sleep(80);
    hk("Tab", "Tab");
    await sleep(100);
    if (!popup() || !get("cv-word").containerId) throw new Error("浮层没开着 / 没切到矩形");
    sapi().updateScene({
      elements: (sapi().getSceneElementsIncludingDeleted() as any[]).map((e) => (e.id === "cv-word" ? { ...e, strokeColor: "#e03131", version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    await sleep(150);
    const closed = !popup();
    hk("Escape", "Escape");
    await sleep(120);
    if (!closed || get("cv-word").strokeColor !== "#e03131") throw new Error(`别人的修改 ${closed} ${get("cv-word").strokeColor}`);
    // 收尾：cv-word 回到独立文本，后面的多选步骤还要用它测文本 → 形状
    await pick("cv-word");
    hk("T", "KeyT", { shiftKey: true });
    await sleep(120);
    if (get("cv-word").containerId) throw new Error("收尾：cv-word 没回到文本");
    return "ok";
  });

  await step("转换形状：多选文本和矩形 ⇧O 都变椭圆；存盘合法", async () => {
    await pick("cv-word", "cv-empty");
    hk("O", "KeyO", { shiftKey: true });
    await sleep(120);
    const w = get("cv-word");
    if (!w.containerId || get(w.containerId).type !== "ellipse" || get("cv-empty").type !== "ellipse") throw new Error(`多选 ${w.containerId && get(w.containerId).type} ${get("cv-empty").type}`);
    await waitFor(() => tabOf(shapes)?.save === "saved", 8000);
    const d = JSON.parse(await ipc.debugRead(shapes));
    const idx = (d.elements as any[]).map((e) => e.index);
    if (idx.some((i) => !i) || [...idx].sort().join() !== idx.join()) throw new Error("元素没按 index 排序");
    if (!(d.elements as any[]).find((e) => e.id === "cv-word")?.containerId) throw new Error("存盘里文字没进容器");
    return { elements: d.elements.length };
  });

  // 批注：收起成小圆点、选中批注按 C 改它（docs/specs/20261124-fold-notes.md）。收起只改画布上的样子，文件永远是原样
  const notesDoc = `${dir}/批注.excalidraw`;
  const napi = () => session(notesDoc).api;
  const nget = (id: string) => (napi().getSceneElementsIncludingDeleted() as any[]).find((e) => e.id === id);
  const nfile = async () => JSON.parse(await ipc.debugRead(notesDoc)).elements as any[];
  const npick = async (...ids: string[]) => {
    napi().updateScene({ appState: { selectedElementIds: Object.fromEntries(ids.map((i) => [i, true])) }, captureUpdate: CaptureUpdateAction.NEVER });
    await sleep(80);
  };
  const savedAfter = async (n: number) => waitFor(() => session(notesDoc).saves > n && tabOf(notesDoc)?.save === "saved", 8000);
  let note = "", parts: string[] = [];
  const shownFolded = () => parts.every((id) => { const e = nget(id); return e.opacity === 0 && e.locked && e.customData?.excalidesk?.folded; });

  await step("批注：选中元素按 C 新建，文件里是原样", async () => {
    toggleNotes(false);
    await write(notesDoc, { type: "excalidraw", version: 2, elements: [rect(0, 0, { id: "nt-box" }), rect(0, 300, { id: "nt-other" })], appState: {}, files: {} });
    await openPath(notesDoc);
    await waitFor(() => ready(notesDoc));
    await sleep(600);
    session(notesDoc).userInput();
    await npick("nt-box");
    const n0 = session(notesDoc).saves;
    hk("c", "KeyC");
    await waitFor(() => getState().commentDraft?.path === notesDoc, 2000);
    commitComment("first note");
    await savedAfter(n0);
    const f = await nfile();
    const n = f.find((e) => e.customData?.excalidesk?.comment);
    if (!n || n.customData.excalidesk.comment.targets[0] !== "nt-box") throw new Error("没建出批注");
    note = n.id;
    parts = f.filter((e) => e.id === note || e.customData?.excalidesk?.commentOf === note).map((e) => e.id);
    if (parts.length !== 3) throw new Error(`批注应该是便签、文字、箭头 ${parts.length}`);
    return { parts: parts.length };
  });

  await step("批注：⇧C 收起——画布上透明、锁住、取消选中、留小圆点；不写盘、不进撤销", async () => {
    const s = session(notesDoc);
    await npick(...parts);
    const before = await ipc.debugRead(notesDoc), n0 = s.saves;
    hk("C", "KeyC", { shiftKey: true });
    await sleep(100);
    if (!getState().notesFolded || !shownFolded()) throw new Error("没收起");
    if (parts.some((id) => napi().getAppState().selectedElementIds[id])) throw new Error("藏起来的批注还选着");
    await waitFor(() => document.querySelectorAll(".xd-pin").length === 1, 2000);
    await sleep(1500);
    if (s.saves !== n0 || s.isDirty() || (await ipc.debugRead(notesDoc)) !== before) throw new Error("收起写了盘");
    // 收起不是一步撤销：⌘Z 撤的是上一步（新建批注）；⇧⌘Z 重做回来的批注照样收着
    undo();
    await sleep(150);
    if (!nget(note).isDeleted) throw new Error("⌘Z 撤的不是新建批注（收起进了撤销记录？）");
    hk("z", "KeyZ", { metaKey: true, shiftKey: true });
    await sleep(150);
    if (nget(note).isDeleted || !shownFolded()) throw new Error("重做回来的批注露出来了");
    return { pins: document.querySelectorAll(".xd-pin").length };
  });

  await step("批注：收起时别的修改照常保存，全量保存也是原样；外部修改载入后仍收起", async () => {
    const s = session(notesDoc);
    await waitFor(() => tabOf(notesDoc)?.save === "saved" && !s.isDirty(), 8000);
    await ipc.externalEdit(notesDoc, rect(400, 300, { id: "nt-ext" }));
    await waitFor(() => !!nget("nt-ext"), 6000);
    if (!shownFolded()) throw new Error("外部修改载入后批注露出来了");
    const n0 = s.saves;
    edit(notesDoc, (els) => els.map((e) => (e.id === "nt-other" ? { ...e, x: e.x + 30, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)));
    await savedAfter(n0);
    if (!s.lastSave.full) throw new Error("这一步要测全量保存");
    const bad = (await nfile()).filter((e) => parts.includes(e.id) && (e.opacity !== 100 || e.locked || e.customData?.excalidesk?.folded));
    if (bad.length) throw new Error(`文件里的批注被改了 ${JSON.stringify(bad.map((e) => [e.id, e.opacity, e.locked]))}`);
    return s.lastSave;
  });

  await step("批注：收起时 Agent 处理批注——文件里是灰色已处理，画布上还收着", async () => {
    await runOp("resolve", { path: notesDoc, agent: "selftest", comments: [{ id: note, reply: "done" }] });
    await waitFor(() => tabOf(notesDoc)?.save === "saved", 8000);
    const f = await nfile();
    const n = f.find((e) => e.id === note), arrow = f.find((e) => parts.includes(e.id) && e.type === "arrow");
    if (n.customData.excalidesk.comment.status !== "resolved" || n.opacity !== 70 || arrow.opacity !== 60 || n.customData.excalidesk.folded) throw new Error(`文件里 ${n.opacity} ${arrow.opacity}`);
    if (!shownFolded() || nget(note).customData.excalidesk.folded.opacity !== 70) throw new Error("画布上露出来了");
    await waitFor(() => document.querySelector(".xd-pin.resolved"), 2000);
    return "ok";
  });

  await step("批注：收起时在藏着的便签上双击、拿文字工具点，Excalidraw 不会改到它（锁住的元素它自己跳过）", async () => {
    const versions = () => JSON.stringify(parts.map((id) => [id, nget(id).version, nget(id).isDeleted]));
    const before = versions();
    const st = napi().getAppState(), n = nget(note), z = st.zoom.value;
    const canvas = document.querySelector(".excalidraw canvas.interactive")!;
    const at = { clientX: (n.x + 20 + st.scrollX) * z + st.offsetLeft, clientY: (n.y + 20 + st.scrollY) * z + st.offsetTop, bubbles: true, cancelable: true };
    const endEdit = async () => {
      document.querySelector(".excalidraw-wysiwyg")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(150);
    };
    const mine = (ed: any) => ed && (parts.includes(ed.id) || ed.containerId === note);
    canvas.dispatchEvent(new MouseEvent("dblclick", at));
    await sleep(120);
    const ed1 = napi().getAppState().editingTextElement;
    await endEdit();
    if (!ed1) throw new Error("双击没开始写字（这一步没测到东西）");
    if (mine(ed1)) throw new Error("双击：开始改藏着的批注了");
    napi().setActiveTool({ type: "text" });
    await sleep(50);
    canvas.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true }));
    canvas.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true }));
    await sleep(120);
    const ed2 = napi().getAppState().editingTextElement;
    await endEdit();
    napi().setActiveTool({ type: "selection" });
    if (mine(ed2)) throw new Error("文字工具：开始改藏着的批注了");
    if (versions() !== before) throw new Error("藏着的批注被改了");
    if (getState().commentDraft) throw new Error("不该打开批注输入框");
    if (!shownFolded()) throw new Error("批注露出来了");
    return { dblclick: !!ed1, textTool: !!ed2 };
  });

  await step("批注：点小圆点改文字——已处理的重新打开，⌘Z 一步撤销", async () => {
    (document.querySelector(".xd-pin") as HTMLElement).click();
    const d = getState().commentDraft;
    if (d?.editing !== note || d.text !== "first note" || !d.resolved) throw new Error(`输入框 ${JSON.stringify(d)}`);
    const n0 = session(notesDoc).saves;
    commitComment("second note");
    await savedAfter(n0);
    const f = await nfile();
    const n = f.find((e) => e.id === note), txt = f.find((e) => e.containerId === note), arrow = f.find((e) => parts.includes(e.id) && e.type === "arrow");
    const c = n.customData.excalidesk.comment;
    if (c.status !== "open" || c.reply || n.opacity !== 100 || n.backgroundColor !== "#ffec99" || arrow.opacity !== 100) throw new Error(`没重新打开 ${JSON.stringify(c)}`);
    if (txt.originalText !== "second note") throw new Error(`文字 ${txt.originalText}`);
    if (!shownFolded()) throw new Error("改完露出来了");
    undo();
    await sleep(150);
    const back = (session(notesDoc).snapshot().elements as any[]).find((e) => e.id === note);
    if (back.customData.excalidesk.comment.status !== "resolved" || back.opacity !== 70) throw new Error("⌘Z 没回到已处理");
    if (!shownFolded()) throw new Error("⌘Z 后批注露出来了");
    return "ok";
  });

  await step("批注：⇧C 展开——回到原样，不写盘", async () => {
    const s = session(notesDoc);
    await waitFor(() => tabOf(notesDoc)?.save === "saved", 8000);
    const n0 = s.saves;
    hk("C", "KeyC", { shiftKey: true });
    await sleep(100);
    if (getState().notesFolded || parts.some((id) => nget(id).customData?.excalidesk?.folded)) throw new Error("没展开");
    if (nget(note).opacity !== 70 || nget(note).locked) throw new Error(`便签 ${nget(note).opacity} ${nget(note).locked}`);
    if (document.querySelector(".xd-pin")) throw new Error("小圆点还在");
    await sleep(1200);
    if (s.saves !== n0) throw new Error("展开写了盘");
    return "ok";
  });

  await step("批注：展开时选中批注按 C 是改它，不会再叠一条", async () => {
    await npick(...parts);
    hk("c", "KeyC");
    const d = getState().commentDraft;
    if (d?.editing !== note || d.text !== "first note") throw new Error(`输入框 ${JSON.stringify(d)}`);
    const n0 = session(notesDoc).saves;
    commitComment("third note");
    await savedAfter(n0);
    const f = await nfile();
    const notes = f.filter((e) => !e.isDeleted && e.customData?.excalidesk?.comment);
    if (notes.length !== 1 || f.find((e) => e.containerId === note).originalText !== "third note") throw new Error(`批注 ${notes.length} 条`);
    return "ok";
  });

  // 撤销重做只换改过的字段：展开时记下的一步，收起后撤销（或反过来），文件里的批注也必须是原样
  const noteFile = async () => {
    const f = await nfile();
    const n = f.find((e) => e.id === note), txt = f.find((e) => e.containerId === note), arrow = f.find((e) => parts.includes(e.id) && e.type === "arrow");
    return { n, txt, arrow, status: n.customData.excalidesk.comment.status, leaked: [n, txt, arrow].filter((e) => e.customData?.excalidesk?.folded || e.locked || e.opacity === 0).map((e) => e.id) };
  };
  await step("批注：展开时改的，收起后 ⌘Z / ⇧⌘Z——文件里批注不透明、没锁、没记号", async () => {
    // 上一步展开时把已处理的批注改成 third note（重新打开）
    hk("C", "KeyC", { shiftKey: true });
    await sleep(100);
    let n0 = session(notesDoc).saves;
    undo();
    await savedAfter(n0);
    let f = await noteFile();
    if (f.leaked.length || f.status !== "resolved" || f.n.opacity !== 70 || f.txt.opacity !== 80 || f.arrow.opacity !== 60) throw new Error(`⌘Z 后 ${JSON.stringify({ leaked: f.leaked, status: f.status, o: [f.n.opacity, f.txt.opacity, f.arrow.opacity] })}`);
    if (!shownFolded()) throw new Error("⌘Z 后批注露出来了");
    n0 = session(notesDoc).saves;
    hk("z", "KeyZ", { metaKey: true, shiftKey: true });
    await savedAfter(n0);
    f = await noteFile();
    if (f.leaked.length || f.status !== "open" || f.n.opacity !== 100 || f.txt.opacity !== 100 || f.arrow.opacity !== 100) throw new Error(`⇧⌘Z 后 ${JSON.stringify({ leaked: f.leaked, status: f.status, o: [f.n.opacity, f.txt.opacity, f.arrow.opacity] })}`);
    hk("C", "KeyC", { shiftKey: true });
    await sleep(100);
    if (getState().notesFolded || nget(note).opacity !== 100 || nget(note).locked) throw new Error("展开后便签不对");
    return "ok";
  });

  await step("批注：展开时 Agent 处理批注，收起后 ⌘Z——文件里批注回到未处理、不透明、没锁", async () => {
    await runOp("resolve", { path: notesDoc, agent: "selftest", comments: [{ id: note, reply: "again" }] });
    await waitFor(() => tabOf(notesDoc)?.save === "saved", 8000);
    hk("C", "KeyC", { shiftKey: true });
    await sleep(100);
    const n0 = session(notesDoc).saves;
    undo();
    await savedAfter(n0);
    const f = await noteFile();
    if (f.leaked.length || f.status !== "open" || f.n.opacity !== 100 || f.txt.opacity !== 100 || f.arrow.opacity !== 100) throw new Error(`${JSON.stringify({ leaked: f.leaked, status: f.status, o: [f.n.opacity, f.txt.opacity, f.arrow.opacity] })}`);
    if (!shownFolded()) throw new Error("批注露出来了");
    hk("C", "KeyC", { shiftKey: true });
    await sleep(100);
    if (parts.some((id) => nget(id).locked || nget(id).opacity === 0)) throw new Error("展开后还锁着或透明");
    return "ok";
  });

  await step("批注：展开时用户自己锁住的批注，存盘是锁住的，收起再展开还锁着", async () => {
    const lockNote = async (locked: boolean) => {
      const n0 = session(notesDoc).saves;
      edit(notesDoc, (els) => els.map((e) => (e.id === note ? { ...e, locked, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)));
      await savedAfter(n0);
      return (await nfile()).find((e) => e.id === note);
    };
    if (getState().notesFolded) throw new Error("这一步要从展开开始");
    const locked = await lockNote(true);
    if (!locked.locked || locked.customData.excalidesk.folded) throw new Error(`锁住后文件里 locked=${locked.locked}`);
    const n0 = session(notesDoc).saves;
    hk("C", "KeyC", { shiftKey: true });
    await sleep(100);
    hk("C", "KeyC", { shiftKey: true });
    await sleep(1200);
    if (!nget(note).locked || nget(note).customData.excalidesk.folded) throw new Error("收起再展开后没锁了");
    if (session(notesDoc).saves !== n0) throw new Error("收起再展开写了盘");
    const unlocked = await lockNote(false);
    if (unlocked.locked) throw new Error("解锁没存下");
    return "ok";
  });

  await step("批注：收起时撤销、展开后再撤销——Excalidraw 撤销快照里留下的拼凑值不会变成锁住 / 透明", async () => {
    hk("C", "KeyC", { shiftKey: true });
    await sleep(100);
    const change = async (text: string) => {
      const n0 = session(notesDoc).saves;
      editComment(session(notesDoc), note);
      commitComment(text);
      await savedAfter(n0);
    };
    const back = async () => {
      const n0 = session(notesDoc).saves;
      undo();
      await savedAfter(n0);
    };
    await change("fourth note");
    await back();
    hk("C", "KeyC", { shiftKey: true });
    await sleep(100);
    await change("fifth note");
    await back();
    const f = await noteFile();
    if (f.leaked.length) throw new Error(`文件里 ${JSON.stringify(f.leaked)}`);
    if (parts.some((id) => nget(id).locked || nget(id).opacity === 0)) throw new Error("画布上的批注锁住 / 透明了");
    return "ok";
  });

  await step("批注：删掉的锁住批注，收起后不会一直抬版本、存盘", async () => {
    const n0 = session(notesDoc).saves;
    edit(notesDoc, (els) => els.map((e) => (parts.includes(e.id) ? { ...e, locked: true, isDeleted: true, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)));
    await savedAfter(n0);
    hk("C", "KeyC", { shiftKey: true });
    await sleep(300);
    const n1 = session(notesDoc).saves, v1 = nget(note).version;
    await sleep(2500);
    const grew = { saves: session(notesDoc).saves - n1, version: nget(note).version - v1 };
    hk("C", "KeyC", { shiftKey: true });
    await sleep(100);
    if (grew.saves || grew.version) throw new Error(`一直在存 ${JSON.stringify(grew)}`);
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
