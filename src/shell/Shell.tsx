import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import "./shell.css";
import { Editor } from "./Editor";
import { basename, dirname, inTauri, ipc, isICloud, type HistoryEntry, type TreeNode } from "./ipc";
import { getState, setState, useShell, type Tab } from "./store";
import { popup } from "./contextMenu";
import {
  activate, boot, closeApp, closeOthers, closeTab, copyPath, cycleTab, duplicatePath, exportActive, flushAll,
  historyAsCopy, newDoc, newFolder, onFsChanged, openFileDialog, openPath, pickRoot, refreshSync, removeRoot,
  renamePath, restoreHistory, revealActive, saveMissingAs, sessions, syncWindowTitle, toggleHistory, trashPath,
  useICloudRoot,
} from "./actions";
import { runSelftest } from "./selftest";

const SELFTEST = new URLSearchParams(location.search).get("selftest") === "1";

const ICLOUD_ROOT = /^\/Users\/[^/]+\/Library\/Mobile Documents\/com~apple~CloudDocs/;
export const prettyPath = (p: string) => p.replace(ICLOUD_ROOT, "iCloud Drive").replace(/^\/Users\/[^/]+/, "~");

function useSystemTheme() {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(mq.matches);
  useEffect(() => {
    const f = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return dark ? "dark" : "light";
}

function onMenu(id: string) {
  const { active } = getState();
  switch (id) {
    case "new": return newDoc();
    case "open": return openFileDialog();
    case "open_folder": return pickRoot();
    case "save": return active && sessions.get(active)?.flush();
    case "export_png": return exportActive("png");
    case "export_svg": return exportActive("svg");
    case "history": return toggleHistory();
    case "reveal": return revealActive();
    case "close_tab": return active ? closeTab(active) : closeApp();
    case "toggle_sidebar": return setSidebar(!getState().sidebar);
    case "focus_mode": return setState((s) => ({ focus: !s.focus }));
    case "next_tab": return cycleTab(1);
    case "prev_tab": return cycleTab(-1);
  }
}

function setSidebar(open: boolean) {
  localStorage.setItem("sidebar", open ? "1" : "0");
  setState({ sidebar: open });
}

// ── 图标（线性，跟随文字颜色）────────────────────────

const Svg = ({ children, size = 14 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const Icon = {
  chevron: (open: boolean) => <span className={`chev ${open ? "open" : ""}`}><Svg size={10}><path d="M6 4l4 4-4 4" /></Svg></span>,
  file: <Svg><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></Svg>,
  folder: <Svg><path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" /></Svg>,
  cloud: <Svg><path d="M4.5 12h7a2.5 2.5 0 0 0 .3-5A3.5 3.5 0 0 0 5 6.2 2.9 2.9 0 0 0 4.5 12z" /></Svg>,
  plus: <Svg><path d="M8 3.5v9M3.5 8h9" /></Svg>,
  close: <Svg size={11}><path d="M4 4l8 8M12 4l-8 8" /></Svg>,
  sidebar: <Svg size={15}><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M6 3v10" /></Svg>,
  history: <Svg><path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7" /><path d="M2.5 2.8v2.4h2.4" /><path d="M8 5.2V8l1.8 1.2" /></Svg>,
};

// ── 外壳 ───────────────────────────────────────────────

export default function Shell() {
  const theme = useSystemTheme();
  const sidebar = useShell((s) => s.sidebar && !s.focus);
  const focus = useShell((s) => s.focus);
  const fullscreen = useShell((s) => s.fullscreen);
  const width = useShell((s) => s.sidebarWidth);
  const activeTitle = useShell((s) => s.tabs.find((t) => t.path === s.active)?.title ?? "");

  useEffect(() => {
    syncWindowTitle(activeTitle);
  }, [activeTitle]);

  useEffect(() => {
    const un: Promise<() => void>[] = !inTauri ? [] : [
      listen<string>("menu", (e) => onMenu(e.payload)),
      listen<string[]>("fs-changed", (e) => onFsChanged(e.payload)),
      listen<string[]>("open-paths", (e) => e.payload.forEach(openPath)),
      listen("app-close-requested", () => closeApp()),
    ];
    if (inTauri) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        const w = getCurrentWindow();
        un.push(w.onResized(async () => setState({ fullscreen: await w.isFullscreen() })));
      });
    }
    (async () => {
      await boot();
      for (const p of await ipc.takePendingOpens()) await openPath(p);
      if (SELFTEST) runSelftest();
    })();
    const onBlur = () => flushAll();
    window.addEventListener("blur", onBlur);
    const sync = window.setInterval(() => refreshSync(getState().active), 4000);
    return () => {
      un.forEach((p) => p.then((f) => f()));
      window.removeEventListener("blur", onBlur);
      clearInterval(sync);
    };
  }, []);

  return (
    <div className={`shell ${theme} ${inTauri ? "native" : ""} ${fullscreen ? "fullscreen" : ""} ${sidebar ? "" : "no-sidebar"}`}>
      {sidebar && <Sidebar width={width} />}
      <main>
        {focus ? <div className="focus-strip" data-tauri-drag-region /> : <TabBar />}
        <div className="workspace">
          <EditorArea theme={theme} />
          <HistoryPanel />
        </div>
        {!focus && <StatusBar />}
      </main>
      <Toast />
    </div>
  );
}

// ── 侧边栏 ─────────────────────────────────────────────

function Sidebar({ width }: { width: number }) {
  const roots = useShell((s) => s.roots);
  const recent = useShell((s) => s.recent);
  const outside = recent.filter((p) => !roots.some((r) => p.startsWith(r + "/"))).slice(0, 6);
  return (
    <aside className="sidebar" style={{ width }} onContextMenu={(e) => { e.preventDefault(); popup([{ text: "添加文件夹…", action: pickRoot }]); }}>
      <div className="side-top" data-tauri-drag-region>
        <button className="icon" title="隐藏侧边栏（⌘\）" onClick={() => setSidebar(false)}>{Icon.sidebar}</button>
      </div>
      <div className="side-head">
        <span>工作区</span>
        <button className="icon" title="添加文件夹（⇧⌘O）" onClick={pickRoot}>{Icon.plus}</button>
      </div>
      <div className="side-scroll">
        {roots.map((r) => <RootSection key={r} root={r} />)}
        {roots.length === 0 && <div className="muted pad">还没有工作区。添加一个文件夹，里面的 .excalidraw 都会列在这里。</div>}
        {outside.length > 0 && (
          <>
            <div className="sec">其他最近打开</div>
            {outside.map((p) => <FileRow key={p} path={p} name={basename(p)} depth={0} dataless={false} />)}
          </>
        )}
      </div>
      <Resizer />
    </aside>
  );
}

function Resizer() {
  const onDown = (e: React.PointerEvent) => {
    const startX = e.clientX, startW = getState().sidebarWidth;
    const move = (ev: PointerEvent) => setState({ sidebarWidth: Math.min(420, Math.max(180, startW + ev.clientX - startX)) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("sidebarWidth", String(getState().sidebarWidth));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className="resizer" onPointerDown={onDown} onDoubleClick={() => { setState({ sidebarWidth: 240 }); localStorage.removeItem("sidebarWidth"); }} />;
}

const openSet = new Set<string>(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
function useCollapsed(path: string): [boolean, () => void] {
  const [collapsed, set] = useState(openSet.has(path));
  return [collapsed, () => {
    collapsed ? openSet.delete(path) : openSet.add(path);
    localStorage.setItem("collapsed", JSON.stringify([...openSet]));
    set(!collapsed);
  }];
}

function folderMenu(path: string, isRoot: boolean) {
  popup([
    { text: "新建图", action: () => newDoc(path) },
    { text: "新建文件夹", action: () => newFolder(path) },
    "-",
    ...(isRoot ? [] : [{ text: "重命名…", action: () => setState({ renaming: path }) }]),
    { text: "在 Finder 中显示", action: () => ipc.reveal(path) },
    { text: "拷贝路径", action: () => copyPath(path) },
    "-",
    isRoot ? { text: "从侧边栏移除", action: () => removeRoot(path) } : { text: "移到废纸篓", action: () => trashPath(path, true) },
  ]);
}

function fileMenu(path: string) {
  const open = sessions.has(path);
  popup([
    { text: "打开", action: () => openPath(path) },
    "-",
    { text: "重命名…", action: () => setState({ renaming: path }) },
    { text: "创建副本", action: () => duplicatePath(path) },
    { text: "历史版本…", action: async () => { await openPath(path); toggleHistory(true); } },
    "-",
    { text: "在 Finder 中显示", action: () => ipc.reveal(path) },
    { text: "拷贝路径", action: () => copyPath(path) },
    "-",
    { text: open ? "关闭并移到废纸篓" : "移到废纸篓", action: () => trashPath(path, false) },
  ]);
}

function RootSection({ root }: { root: string }) {
  const nodes = useShell((s) => s.trees[root]);
  const [collapsed, toggle] = useCollapsed(root);
  const icloud = isICloud(root);
  return (
    <div className="root">
      <div className="row root-row" onClick={toggle} title={prettyPath(root)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); folderMenu(root, true); }}>
        {Icon.chevron(!collapsed)}
        <span className="row-icon">{icloud ? Icon.cloud : Icon.folder}</span>
        <span className="grow ellipsis">{basename(root)}</span>
        <button className="icon hover-only" title="在这里新建图" onClick={(e) => { e.stopPropagation(); newDoc(root); }}>{Icon.plus}</button>
      </div>
      {!collapsed && (nodes?.length
        ? nodes.map((n) => <TreeItem key={n.path} node={n} depth={1} />)
        : <div className="muted row empty-row">{nodes ? "还没有图" : "读取中…"}</div>)}
    </div>
  );
}

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const [collapsed, toggle] = useCollapsed(node.path);
  const renaming = useShell((s) => s.renaming === node.path);
  if (!node.dir) return <FileRow path={node.path} name={node.name} depth={depth} dataless={node.dataless} />;
  return (
    <>
      <div className="row" style={{ paddingLeft: 6 + depth * 14 }} onClick={toggle} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); folderMenu(node.path, false); }}>
        {Icon.chevron(!collapsed)}
        <span className="row-icon">{Icon.folder}</span>
        {renaming ? <RenameInput path={node.path} initial={node.name} /> : <span className="grow ellipsis">{node.name}</span>}
      </div>
      {!collapsed && node.children?.map((c) => <TreeItem key={c.path} node={c} depth={depth + 1} />)}
    </>
  );
}

function FileRow({ path, name, depth, dataless }: { path: string; name: string; depth: number; dataless: boolean }) {
  const active = useShell((s) => s.active === path);
  const renaming = useShell((s) => s.renaming === path);
  const tab = useShell((s) => s.tabs.find((t) => t.path === path));
  return (
    <div
      className={`row file ${active ? "on" : ""}`}
      style={{ paddingLeft: 20 + depth * 14 }}
      onClick={() => !renaming && openPath(path)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); fileMenu(path); }}
      title={prettyPath(path)}
    >
      <span className="row-icon">{Icon.file}</span>
      {renaming ? <RenameInput path={path} initial={name} /> : <span className="grow ellipsis">{name}</span>}
      {tab && tab.save !== "saved" && !renaming && <span className="dot" />}
      {dataless && <span className="muted row-icon" title="仅在 iCloud，打开时下载">{Icon.cloud}</span>}
    </div>
  );
}

function RenameInput({ path, initial }: { path: string; initial: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    renamePath(path, ref.current?.value ?? initial);
  };
  return (
    <input
      ref={ref}
      className="rename"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { done.current = true; setState({ renaming: null }); }
      }}
      onBlur={commit}
    />
  );
}

// ── 标签栏 / 状态栏 ────────────────────────────────────

function TabBar() {
  const tabs = useShell((s) => s.tabs);
  const active = useShell((s) => s.active);
  const sidebar = useShell((s) => s.sidebar);
  return (
    <div className="tabbar" data-tauri-drag-region onDoubleClick={(e) => e.target === e.currentTarget && newDoc()}>
      {!sidebar && <button className="icon show-sidebar" title="显示侧边栏（⌘\）" onClick={() => setSidebar(true)}>{Icon.sidebar}</button>}
      {tabs.map((t) => (
        <div
          key={t.path}
          className={`tab ${t.path === active ? "on" : ""} ${t.missing ? "missing" : ""}`}
          onClick={() => activate(t.path)}
          onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            popup([
              { text: "关闭", action: () => closeTab(t.path) },
              { text: "关闭其他标签页", action: () => closeOthers(t.path), enabled: tabs.length > 1 },
              "-",
              { text: "历史版本…", action: async () => { await activate(t.path); toggleHistory(true); } },
              { text: "在 Finder 中显示", action: () => ipc.reveal(t.path), enabled: !t.missing },
              { text: "拷贝路径", action: () => copyPath(t.path) },
            ]);
          }}
          title={prettyPath(t.path)}
        >
          <span className="ellipsis">{t.title}</span>
          <span className="tab-end">
            {t.save === "error" ? <span className="err-dot" /> : t.save !== "saved" ? <span className="dot" /> : null}
            <button className="icon close" onClick={(e) => { e.stopPropagation(); closeTab(t.path); }} title="关闭（⌘W）">{Icon.close}</button>
          </span>
        </div>
      ))}
      <button className="icon new-tab" title="新建图（⌘N）" onClick={() => newDoc()}>{Icon.plus}</button>
    </div>
  );
}

const time = (t?: number) => (t ? new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "");

function saveText(t: Tab) {
  if (t.phase === "loading") return "正在打开…";
  if (t.phase === "downloading") return "正在从 iCloud 下载…";
  if (t.phase === "error") return "打不开";
  if (t.missing) return "文件已不在原位置，自动保存已暂停";
  switch (t.save) {
    case "saved": return t.savedAt ? `已保存 ${time(t.savedAt)}` : "已打开";
    case "dirty": return "有未保存的修改";
    case "saving": return "保存中…";
    case "error": return `保存失败：${t.saveError}`;
  }
}

function StatusBar() {
  const tab = useShell((s) => s.tabs.find((t) => t.path === s.active));
  const sync = useShell((s) => (s.active ? s.sync[s.active] : undefined));
  if (!tab) return null;
  let syncText = "";
  if (sync?.ubiquitous) {
    syncText = sync.conflict ? "iCloud 有冲突版本，正在合并" : sync.uploading ? "正在上传到 iCloud" : sync.uploaded ? "iCloud 已同步" : "等待上传到 iCloud";
  }
  return (
    <div className="statusbar">
      <span className={tab.save === "error" || tab.missing ? "err" : ""}>{saveText(tab)}</span>
      {syncText && <span>{syncText}</span>}
      {tab.phase === "ready" && <span>{tab.elements} 个元素</span>}
      <span className="grow" />
      <button className="link" onClick={() => toggleHistory()} title="历史版本（⌥⌘Y）">{Icon.history}<span>历史版本</span></button>
      <span className="ellipsis path" title={tab.path}>{prettyPath(dirname(tab.path))}</span>
    </div>
  );
}

// ── 编辑区 ─────────────────────────────────────────────

function EditorArea({ theme }: { theme: "light" | "dark" }) {
  const tab = useShell((s) => s.tabs.find((t) => t.path === s.active));
  if (!tab) return <Welcome />;
  const session = sessions.get(tab.path);
  const dismiss = () => setState((s) => ({ tabs: s.tabs.map((t) => (t.path === tab.path ? { ...t, banner: undefined } : t)) }));
  return (
    <div className="editor">
      {tab.missing ? (
        <div className="banner warn">
          <span>「{tab.title}」已在外部被删除或移走</span>
          <button onClick={() => session?.restoreAtPath()}>存回原位置</button>
          <button onClick={() => saveMissingAs(tab.path)}>另存为…</button>
          <button onClick={() => closeTab(tab.path)}>关闭</button>
        </div>
      ) : tab.banner ? (
        <div className="banner">
          <span>{tab.banner}</span>
          <button className="icon" onClick={dismiss}>{Icon.close}</button>
        </div>
      ) : null}
      {tab.phase === "ready" && session ? (
        <Editor session={session} theme={theme} />
      ) : (
        <div className="placeholder">
          {tab.phase === "error" ? (
            <>
              <div>打不开「{tab.title}」</div>
              <div className="muted small selectable">{tab.error}</div>
              <div className="actions">
                <button onClick={() => { closeTab(tab.path).then(() => openPath(tab.path)); }}>重试</button>
                <button onClick={() => closeTab(tab.path)}>关闭</button>
              </div>
            </>
          ) : (
            <div className="muted">{tab.phase === "downloading" ? "正在从 iCloud 下载…" : "正在打开…"}</div>
          )}
        </div>
      )}
    </div>
  );
}

const REASON: Record<string, string> = {
  auto: "自动", before_external: "外部修改前", before_conflict: "合并冲突前", before_restore: "恢复前",
};

function when(ts: number) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function HistoryPanel() {
  const open = useShell((s) => s.history);
  const active = useShell((s) => s.active);
  const [list, setList] = useState<HistoryEntry[] | null>(null);
  useEffect(() => {
    if (open && active) {
      setList(null);
      ipc.historyList(active).then(setList);
    }
  }, [open, active]);
  if (!open || !active) return null;
  return (
    <aside className="history">
      <div className="history-head">
        <b>历史版本</b>
        <button className="icon" onClick={() => toggleHistory(false)} title="关闭">{Icon.close}</button>
      </div>
      <p className="muted small">编辑时每 5 分钟留一份，合并外部修改、恢复之前也会先留一份。只存在这台 Mac 上。</p>
      <div className="history-list">
        {list === null && <div className="muted small">读取中…</div>}
        {list?.length === 0 && <div className="muted small">还没有历史版本。编辑并保存后会自动生成。</div>}
        {list?.map((e) => (
          <div key={e.id} className="history-item">
            <div className="grow">
              <div>{when(e.ts)}</div>
              <div className="muted small">{REASON[e.reason] ?? e.reason} · {e.elements} 个元素</div>
            </div>
            <div className="history-actions">
              <button onClick={() => restoreHistory(e.id)}>恢复</button>
              <button onClick={() => historyAsCopy(e.id, e.ts)} title="另存为同目录下的新文件">副本</button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Welcome() {
  const roots = useShell((s) => s.roots);
  const recent = useShell((s) => s.recent).slice(0, 8);
  if (!roots.length) {
    return (
      <div className="welcome">
        <img src="/icon.png" alt="" className="welcome-logo" />
        <h1>图存在哪</h1>
        <p className="muted">文件就是标准 .excalidraw，excalidraw.com、Obsidian 插件都能直接打开。</p>
        <div className="cards">
          <button className="card primary" onClick={useICloudRoot}>
            <b>{Icon.cloud} iCloud Drive</b>
            <span className="muted">在 iCloud Drive 里建一个「Excalidraw」文件夹，在你的 Mac 之间自动同步。</span>
          </button>
          <button className="card" onClick={pickRoot}>
            <b>{Icon.folder} 本地文件夹</b>
            <span className="muted">选任意文件夹，适合放进 git 仓库或其他同步盘。</span>
          </button>
        </div>
        <p className="muted small">之后还可以在侧边栏添加更多文件夹。</p>
      </div>
    );
  }
  return (
    <div className="welcome">
      <img src="/icon.png" alt="" className="welcome-logo small-logo" />
      <div className="actions">
        <button onClick={() => newDoc()}>新建图 <kbd>⌘N</kbd></button>
        <button onClick={openFileDialog}>打开… <kbd>⌘O</kbd></button>
      </div>
      {recent.length > 0 && (
        <div className="recent">
          <div className="sec">最近打开</div>
          {recent.map((p) => (
            <div key={p} className="row file" onClick={() => openPath(p)}>
              <span className="row-icon">{Icon.file}</span>
              <span className="grow ellipsis">{basename(p)}</span>
              <span className="muted ellipsis small">{prettyPath(dirname(p))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Toast() {
  const msg = useShell((s) => s.toast);
  return msg ? <div className="toast">{msg}</div> : null;
}
