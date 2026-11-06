import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import "./shell.css";
import { Editor } from "./Editor";
import { basename, dirname, inTauri, ipc, isICloud, type HistoryEntry, type TreeNode } from "./ipc";
import { getState, hidePrompt, setState, updateSettings, useShell, type Settings, type Tab } from "./store";
import { t, useT, type Key } from "./i18n";
import { popup } from "./contextMenu";
import {
  activate, boot, closeApp, closeOthers, closeTab, copyPath, cycleTab, duplicatePath, exportActive, flushAll,
  historyAsCopy, moveRoot, newDoc, newFolder, onFsChanged, openFileDialog, openPath, pickRoot, refreshSync,
  removeRecent, removeRoot, renamePath, restoreHistory, revealActive, saveMissingAs, sessions, syncNative,
  syncWindowTitle, toggleHistory, trashPath, useICloudRoot,
} from "./actions";
import { runSelftest } from "./selftest";
import { checkForUpdates, scheduleUpdateChecks } from "./updater";

const SELFTEST = new URLSearchParams(location.search).get("selftest") === "1";

const ICLOUD_ROOT = /^\/Users\/[^/]+\/Library\/Mobile Documents\/com~apple~CloudDocs/;
export const prettyPath = (p: string) => p.replace(ICLOUD_ROOT, "iCloud Drive").replace(/^\/Users\/[^/]+/, "~");

function useSystemDark() {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(mq.matches);
  useEffect(() => {
    const f = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return dark;
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
    case "settings": return setState({ settingsOpen: true });
    case "check_updates": return checkForUpdates(true);
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
  sort: <Svg><path d="M4.5 3v10M2.5 11l2 2 2-2M9 4.5h4.5M9 8h3.2M9 11.5h2" /></Svg>,
  gear: <Svg size={15}><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></Svg>,
};

/** App 标志：随主题变色的矢量版（纸面、紫色手绘圆、铅笔） */
const Logo = ({ text = true }: { text?: boolean }) => (
  <span className="logo" title="Excalidesk">
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" className="logo-tile" />
      <path d="M12.6 6.2c-3.6-.6-6.7 1.6-6.9 4.9-.2 3.4 2.5 6 5.9 5.9 1.4-.1 2.6-.5 3.5-1.3" className="logo-ring" />
      <path d="M18.2 6.4l-5.6 8" className="logo-pencil" />
      <path d="M12.6 14.4l-.7 1.9 1.7-1.1z" className="logo-tip" />
    </svg>
    {text && <b>Excalidesk</b>}
  </span>
);

// ── 外壳 ───────────────────────────────────────────────

export default function Shell() {
  const systemDark = useSystemDark();
  const settings = useShell((s) => s.settings);
  const lang = useShell((s) => s.lang);
  const theme: "light" | "dark" = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  const sidebar = useShell((s) => s.sidebar && !s.focus);
  const focus = useShell((s) => s.focus);
  const fullscreen = useShell((s) => s.fullscreen);
  const width = useShell((s) => s.sidebarWidth);
  const activeTitle = useShell((s) => s.tabs.find((t) => t.path === s.active)?.title ?? "");

  useEffect(() => {
    syncWindowTitle(activeTitle);
  }, [activeTitle]);
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    syncNative(lang, settings.theme);
  }, [lang, settings.theme]);

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && getState().settingsOpen) setState({ settingsOpen: false });
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    const sync = window.setInterval(() => refreshSync(getState().active), 4000);
    const stopUpdates = SELFTEST ? () => {} : scheduleUpdateChecks();
    return () => {
      stopUpdates();
      un.forEach((p) => p.then((f) => f()));
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey);
      clearInterval(sync);
    };
  }, []);

  return (
    <div className={`shell ${theme} ${inTauri ? "native" : ""} ${fullscreen ? "fullscreen" : ""} ${sidebar ? "" : "no-sidebar"}`}>
      {sidebar && <Sidebar width={width} />}
      <main>
        {focus ? <div className="focus-strip" data-tauri-drag-region /> : <TabBar />}
        <div className="workspace">
          <EditorArea theme={theme} lang={lang} />
          <HistoryPanel />
        </div>
        {!focus && <StatusBar />}
      </main>
      <SettingsDialog />
      <PromptToast />
      <Toast />
    </div>
  );
}

// ── 侧边栏 ─────────────────────────────────────────────

function sortMenu() {
  const cur = getState().settings.sort;
  const opt = (k: Settings["sort"], key: Key) => ({ text: `${cur === k ? "✓ " : "    "}${t(key)}`, action: () => updateSettings({ sort: k }) });
  popup([opt("mtime", "sort.mtime"), opt("ctime", "sort.ctime"), opt("name", "sort.name")]);
}

function Sidebar({ width }: { width: number }) {
  const t = useT();
  const roots = useShell((s) => s.roots);
  const recent = useShell((s) => s.recent);
  const outside = recent.filter((p) => !roots.some((r) => p.startsWith(r + "/"))).slice(0, 6);
  return (
    <aside className="sidebar" style={{ width }} onContextMenu={(e) => { e.preventDefault(); popup([{ text: `${t("side.addFolder")}…`, action: pickRoot }]); }}>
      <div className="side-top" data-tauri-drag-region>
        <Logo />
        <span className="grow" data-tauri-drag-region />
        <button className="icon" title={t("side.hide")} onClick={() => setSidebar(false)}>{Icon.sidebar}</button>
      </div>
      <div className="side-head">
        <span>{t("side.workspaces")}</span>
        <span className="side-head-actions">
          <button className="icon" title={t("side.sort")} onClick={sortMenu}>{Icon.sort}</button>
          <button className="icon" title={t("side.addFolderHint")} onClick={pickRoot}>{Icon.plus}</button>
        </span>
      </div>
      <div className="side-scroll">
        {roots.map((r) => <RootSection key={r} root={r} />)}
        {roots.length === 0 && <div className="muted pad">{t("side.empty")}</div>}
        {outside.length > 0 && (
          <>
            <div className="sec">{t("side.otherRecent")}</div>
            {outside.map((p) => <FileRow key={p} path={p} name={basename(p)} depth={0} dataless={false} recentOnly />)}
          </>
        )}
      </div>
      <div className="side-foot">
        <button className="icon" title={t("side.settings")} onClick={() => setState({ settingsOpen: true })}>{Icon.gear}</button>
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

const collapsedSet = new Set<string>(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
function useCollapsed(path: string): [boolean, () => void] {
  const [collapsed, set] = useState(collapsedSet.has(path));
  return [collapsed, () => {
    collapsed ? collapsedSet.delete(path) : collapsedSet.add(path);
    localStorage.setItem("collapsed", JSON.stringify([...collapsedSet]));
    set(!collapsed);
  }];
}

/** 文件夹在前；文件夹的时间取它里面最新的那张图 */
export function sortTree(nodes: TreeNode[], mode: Settings["sort"], lang: string): TreeNode[] {
  const coll = new Intl.Collator(lang === "zh" ? "zh-CN" : "en", { numeric: true, sensitivity: "base" });
  const own = (n: TreeNode) => (mode === "ctime" ? n.ctime : n.mtime);
  const time = (n: TreeNode): number => (n.dir ? Math.max(own(n), ...(n.children ?? []).map(time)) : own(n));
  const sorted = [...nodes].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (mode !== "name") {
      const d = time(b) - time(a);
      if (d) return d;
    }
    return coll.compare(a.name, b.name);
  });
  return sorted.map((n) => (n.dir && n.children ? { ...n, children: sortTree(n.children, mode, lang) } : n));
}

function folderMenu(path: string, isRoot: boolean) {
  popup([
    { text: t("menu.newDrawing"), action: () => newDoc(path) },
    { text: t("menu.newFolder"), action: () => newFolder(path) },
    "-",
    ...(isRoot ? [] : [{ text: t("menu.rename"), action: () => setState({ renaming: path }) }]),
    { text: t("menu.reveal"), action: () => ipc.reveal(path) },
    { text: t("menu.copyPath"), action: () => copyPath(path) },
    "-",
    isRoot ? { text: t("menu.removeRoot"), action: () => removeRoot(path) } : { text: t("menu.trash"), action: () => trashPath(path, true) },
  ]);
}

function fileMenu(path: string, recentOnly: boolean) {
  const open = sessions.has(path);
  popup([
    { text: t("menu.open"), action: () => openPath(path) },
    "-",
    { text: t("menu.rename"), action: () => setState({ renaming: path }) },
    { text: t("menu.duplicate"), action: () => duplicatePath(path) },
    { text: t("menu.history"), action: async () => { await openPath(path); toggleHistory(true); } },
    "-",
    { text: t("menu.reveal"), action: () => ipc.reveal(path) },
    { text: t("menu.copyPath"), action: () => copyPath(path) },
    ...(recentOnly ? [{ text: t("menu.removeRecent"), action: () => removeRecent(path) }] : []),
    "-",
    { text: open ? t("menu.closeAndTrash") : t("menu.trash"), action: () => trashPath(path, false) },
  ]);
}

/** 正在拖动的工作区（HTML5 拖放；Tauri 自己的文件拖放已关掉，所以 WebView 里的拖放可用） */
let draggingRoot: string | null = null;

function RootSection({ root }: { root: string }) {
  const t = useT();
  const nodes = useShell((s) => s.trees[root]);
  const sort = useShell((s) => s.settings.sort);
  const lang = useShell((s) => s.lang);
  const sorted = useMemo(() => (nodes ? sortTree(nodes, sort, lang) : nodes), [nodes, sort, lang]);
  const [collapsed, toggle] = useCollapsed(root);
  const [drop, setDrop] = useState<"" | "above" | "below">("");
  const icloud = isICloud(root);
  return (
    <div className={`root ${drop ? `drop-${drop}` : ""}`}>
      <div
        className="row root-row"
        draggable
        onDragStart={(e) => { draggingRoot = root; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", root); }}
        onDragEnd={() => { draggingRoot = null; setDrop(""); }}
        onDragOver={(e) => {
          if (!draggingRoot || draggingRoot === root) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setDrop(e.clientY < r.top + r.height / 2 ? "above" : "below");
        }}
        onDragLeave={() => setDrop("")}
        onDrop={(e) => {
          e.preventDefault();
          const from = draggingRoot, below = drop === "below";
          setDrop("");
          if (from && from !== root) moveRoot(from, root, below);
        }}
        onClick={toggle}
        title={`${prettyPath(root)} · ${t("side.dragHint")}`}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); folderMenu(root, true); }}
      >
        {Icon.chevron(!collapsed)}
        <span className="row-icon">{icloud ? Icon.cloud : Icon.folder}</span>
        <span className="grow ellipsis">{basename(root)}</span>
        <button className="icon hover-only" title={t("side.newHere")} onClick={(e) => { e.stopPropagation(); newDoc(root); }}>{Icon.plus}</button>
      </div>
      {!collapsed && (sorted?.length
        ? sorted.map((n) => <TreeItem key={n.path} node={n} depth={1} />)
        : <div className="muted row empty-row">{sorted ? t("side.noDrawings") : t("side.loading")}</div>)}
    </div>
  );
}

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const [collapsed, toggle] = useCollapsed(node.path);
  const renaming = useShell((s) => s.renaming === node.path);
  if (!node.dir) return <FileRow path={node.path} name={node.name} depth={depth} dataless={node.dataless} />;
  return (
    <>
      <div
        className="row"
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={toggle}
        onDoubleClick={(e) => { e.stopPropagation(); setState({ renaming: node.path }); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); folderMenu(node.path, false); }}
      >
        {Icon.chevron(!collapsed)}
        <span className="row-icon">{Icon.folder}</span>
        {renaming ? <RenameInput path={node.path} initial={node.name} /> : <span className="grow ellipsis">{node.name}</span>}
      </div>
      {!collapsed && node.children?.map((c) => <TreeItem key={c.path} node={c} depth={depth + 1} />)}
    </>
  );
}

function FileRow({ path, name, depth, dataless, recentOnly = false }: { path: string; name: string; depth: number; dataless: boolean; recentOnly?: boolean }) {
  const t = useT();
  const active = useShell((s) => s.active === path);
  const renaming = useShell((s) => s.renaming === path);
  const tab = useShell((s) => s.tabs.find((x) => x.path === path));
  return (
    <div
      className={`row file ${active ? "on" : ""}`}
      style={{ paddingLeft: 20 + depth * 14 }}
      onClick={() => !renaming && openPath(path)}
      onDoubleClick={(e) => { e.stopPropagation(); setState({ renaming: path }); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); fileMenu(path, recentOnly); }}
      title={prettyPath(path)}
    >
      <span className="row-icon">{Icon.file}</span>
      {renaming ? <RenameInput path={path} initial={name} /> : <span className="grow ellipsis">{name}</span>}
      {tab && tab.save !== "saved" && !renaming && <span className="dot" />}
      {dataless && <span className="muted row-icon" title={t("side.cloudOnly")}>{Icon.cloud}</span>}
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
      onDoubleClick={(e) => e.stopPropagation()}
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
  const t = useT();
  const tabs = useShell((s) => s.tabs);
  const active = useShell((s) => s.active);
  const sidebar = useShell((s) => s.sidebar);
  return (
    <div className="tabbar" data-tauri-drag-region onDoubleClick={(e) => e.target === e.currentTarget && newDoc()}>
      {!sidebar && (
        <>
          <Logo text={false} />
          <button className="icon show-sidebar" title={t("side.show")} onClick={() => setSidebar(true)}>{Icon.sidebar}</button>
        </>
      )}
      {tabs.map((tab) => (
        <div
          key={tab.path}
          className={`tab ${tab.path === active ? "on" : ""} ${tab.missing ? "missing" : ""}`}
          onClick={() => activate(tab.path)}
          onAuxClick={(e) => e.button === 1 && closeTab(tab.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            popup([
              { text: t("menu.close"), action: () => closeTab(tab.path) },
              { text: t("menu.closeOthers"), action: () => closeOthers(tab.path), enabled: tabs.length > 1 },
              "-",
              { text: t("menu.history"), action: async () => { await activate(tab.path); toggleHistory(true); } },
              { text: t("menu.reveal"), action: () => ipc.reveal(tab.path), enabled: !tab.missing },
              { text: t("menu.copyPath"), action: () => copyPath(tab.path) },
            ]);
          }}
          title={prettyPath(tab.path)}
        >
          <span className="ellipsis">{tab.title}</span>
          <span className="tab-end">
            {tab.save === "error" ? <span className="err-dot" /> : tab.save !== "saved" ? <span className="dot" /> : null}
            <button className="icon close" onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }} title={t("tab.close")}>{Icon.close}</button>
          </span>
        </div>
      ))}
      <button className="icon new-tab" title={t("tab.new")} onClick={() => newDoc()}>{Icon.plus}</button>
    </div>
  );
}

const time = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString(getState().lang === "zh" ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" }) : "");

function saveText(tab: Tab) {
  if (tab.phase === "loading") return t("status.loading");
  if (tab.phase === "downloading") return t("status.downloading");
  if (tab.phase === "error") return t("status.error");
  if (tab.missing) return t("status.missing");
  switch (tab.save) {
    case "saved": return tab.savedAt ? t("status.saved", { time: time(tab.savedAt) }) : t("status.opened");
    case "dirty": return t("status.dirty");
    case "saving": return t("status.saving");
    case "error": return t("status.saveError", { error: tab.saveError ?? "" });
  }
}

function StatusBar() {
  const t = useT();
  const tab = useShell((s) => s.tabs.find((x) => x.path === s.active));
  const sync = useShell((s) => (s.active ? s.sync[s.active] : undefined));
  if (!tab) return null;
  let syncText = "";
  if (sync?.ubiquitous) {
    syncText = sync.conflict ? t("sync.conflict") : sync.uploading ? t("sync.uploading") : sync.uploaded ? t("sync.uploaded") : t("sync.waiting");
  }
  return (
    <div className="statusbar">
      <span className={tab.save === "error" || tab.missing ? "err" : ""}>{saveText(tab)}</span>
      {syncText && <span>{syncText}</span>}
      {tab.phase === "ready" && <span>{t("status.elements", { n: tab.elements })}</span>}
      <span className="grow" />
      <button className="link" onClick={() => toggleHistory()} title="⌥⌘Y">{Icon.history}<span>{t("status.history")}</span></button>
      <span className="ellipsis path" title={tab.path}>{prettyPath(dirname(tab.path))}</span>
    </div>
  );
}

// ── 编辑区 ─────────────────────────────────────────────

/** 打开超过 6 秒：提示可能在等 iCloud 下载，并给一个关闭按钮 */
function Opening({ tab }: { tab: Tab }) {
  const t = useT();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const left = 6000 - (Date.now() - (tab.openedAt ?? Date.now()));
    const id = window.setTimeout(() => setSlow(true), Math.max(0, left));
    return () => clearTimeout(id);
  }, [tab.path]);
  return (
    <>
      <div className="spinner" />
      <div className="muted">{tab.phase === "downloading" ? t("status.downloading") : t("status.loading")}</div>
      {slow && (
        <>
          <div className="muted small slow">{t("editor.slow")}</div>
          <button onClick={() => closeTab(tab.path)}>{t("editor.closeTab")}</button>
        </>
      )}
    </>
  );
}

function EditorArea({ theme, lang }: { theme: "light" | "dark"; lang: "zh" | "en" }) {
  const t = useT();
  const tab = useShell((s) => s.tabs.find((x) => x.path === s.active));
  if (!tab) return <Welcome />;
  const session = sessions.get(tab.path);
  const dismiss = () => setState((s) => ({ tabs: s.tabs.map((x) => (x.path === tab.path ? { ...x, banner: undefined } : x)) }));
  return (
    <div className="editor">
      {tab.missing ? (
        <div className="banner warn">
          <span>{t("editor.missing", { title: tab.title })}</span>
          <button onClick={() => session?.restoreAtPath()}>{t("editor.restoreAtPath")}</button>
          <button onClick={() => saveMissingAs(tab.path)}>{t("editor.saveAs")}</button>
          <button onClick={() => closeTab(tab.path)}>{t("app.close")}</button>
        </div>
      ) : tab.banner ? (
        <div className="banner">
          <span>{tab.banner}</span>
          <button className="icon" onClick={dismiss}>{Icon.close}</button>
        </div>
      ) : null}
      {tab.phase === "ready" && session ? (
        <Editor session={session} theme={theme} lang={lang} />
      ) : (
        <div className="placeholder">
          {tab.phase === "error" ? (
            <>
              <div>{t("editor.cantOpen", { title: tab.title })}</div>
              <div className="muted small selectable">{tab.error}</div>
              <div className="actions">
                <button onClick={() => { closeTab(tab.path).then(() => openPath(tab.path)); }}>{t("app.retry")}</button>
                <button onClick={() => closeTab(tab.path)}>{t("app.close")}</button>
              </div>
            </>
          ) : (
            <Opening tab={tab} />
          )}
        </div>
      )}
    </div>
  );
}

function when(ts: number) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString(getState().lang === "zh" ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return t("history.today", { hm });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t("history.yesterday", { hm });
  return t("history.date", { m: d.getMonth() + 1, d: d.getDate(), hm });
}

const REASONS = new Set(["auto", "before_external", "before_conflict", "before_restore"]);

function HistoryPanel() {
  const t = useT();
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
  const reason = (r: string) => (REASONS.has(r) ? t(`reason.${r}` as Key) : r);
  return (
    <aside className="history">
      <div className="history-head">
        <b>{t("history.title")}</b>
        <button className="icon" onClick={() => toggleHistory(false)} title={t("app.close")}>{Icon.close}</button>
      </div>
      <p className="muted small">{t("history.desc")}</p>
      <div className="history-list">
        {list === null && <div className="muted small">{t("side.loading")}</div>}
        {list?.length === 0 && <div className="muted small">{t("history.empty")}</div>}
        {list?.map((e) => (
          <div key={e.id} className="history-item">
            <div className="grow">
              <div>{when(e.ts)}</div>
              <div className="muted small">{t("history.elements", { reason: reason(e.reason), n: e.elements })}</div>
            </div>
            <div className="history-actions">
              <button onClick={() => restoreHistory(e.id)}>{t("history.restore")}</button>
              <button onClick={() => historyAsCopy(e.id, e.ts)} title={t("history.copyHint")}>{t("history.copy")}</button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Welcome() {
  const t = useT();
  const roots = useShell((s) => s.roots);
  const recent = useShell((s) => s.recent).slice(0, 8);
  if (!roots.length) {
    return (
      <div className="welcome">
        <img src="/icon.png" alt="" className="welcome-logo" />
        <h1>{t("welcome.where")}</h1>
        <p className="muted">{t("welcome.desc")}</p>
        <div className="cards">
          <button className="card primary" onClick={useICloudRoot}>
            <b>{Icon.cloud} iCloud Drive</b>
            <span className="muted">{t("welcome.icloudDesc")}</span>
          </button>
          <button className="card" onClick={pickRoot}>
            <b>{Icon.folder} {t("welcome.local")}</b>
            <span className="muted">{t("welcome.localDesc")}</span>
          </button>
        </div>
        <p className="muted small">{t("welcome.later")}</p>
      </div>
    );
  }
  return (
    <div className="welcome">
      <img src="/icon.png" alt="" className="welcome-logo small-logo" />
      <div className="actions">
        <button onClick={() => newDoc()}>{t("welcome.new")} <kbd>⌘N</kbd></button>
        <button onClick={openFileDialog}>{t("welcome.open")} <kbd>⌘O</kbd></button>
      </div>
      {recent.length > 0 && (
        <div className="recent">
          <div className="sec">{t("welcome.recent")}</div>
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

// ── 设置 ───────────────────────────────────────────────

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

function SettingsDialog() {
  const t = useT();
  const open = useShell((s) => s.settingsOpen);
  const s = useShell((x) => x.settings);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setState({ settingsOpen: false })}>
      <div className="modal" role="dialog" aria-label={t("settings.title")}>
        <div className="modal-head">
          <b>{t("settings.title")}</b>
          <button className="icon" onClick={() => setState({ settingsOpen: false })} title={t("app.close")}>{Icon.close}</button>
        </div>
        <div className="setting">
          <span>{t("settings.appearance")}</span>
          <Segmented value={s.theme} onChange={(theme) => updateSettings({ theme })} options={[["system", t("settings.system")], ["light", t("settings.light")], ["dark", t("settings.dark")]]} />
        </div>
        <div className="setting">
          <span>{t("settings.language")}</span>
          <Segmented value={s.lang} onChange={(lang) => updateSettings({ lang })} options={[["system", t("settings.system")], ["zh", t("settings.zh")], ["en", t("settings.en")]]} />
        </div>
        <div className="setting">
          <span>{t("settings.sort")}</span>
          <select value={s.sort} onChange={(e) => updateSettings({ sort: e.target.value as Settings["sort"] })}>
            <option value="mtime">{t("sort.mtime")}</option>
            <option value="ctime">{t("sort.ctime")}</option>
            <option value="name">{t("sort.name")}</option>
          </select>
        </div>
        {inTauri && <UpdateSettings />}
      </div>
    </div>
  );
}

/** 只在 App 里：浏览器预览没有可更新的东西 */
function UpdateSettings() {
  const t = useT();
  const autoUpdate = useShell((s) => s.settings.autoUpdate);
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    import("@tauri-apps/api/app").then((m) => m.getVersion()).then(setVersion, () => {});
  }, []);
  const checkNow = async () => {
    setChecking(true);
    await checkForUpdates(true);
    setChecking(false);
  };
  return (
    <>
      <label className="setting">
        <span>
          {t("settings.autoUpdate")}
          <span className="setting-desc">{t("settings.autoUpdateDesc")}</span>
        </span>
        <input type="checkbox" checked={autoUpdate} onChange={(e) => updateSettings({ autoUpdate: e.target.checked })} />
      </label>
      <div className="setting">
        <span>{version ? t("settings.version", { version }) : "Excalidesk"}</span>
        <button disabled={checking} onClick={() => void checkNow()}>{checking ? t("settings.checking") : t("settings.checkNow")}</button>
      </div>
    </>
  );
}

/** 等用户处理的提示：不自动消失，可以关掉 */
function PromptToast() {
  const t = useT();
  const p = useShell((s) => s.prompt);
  if (!p) return null;
  return (
    <div className="toast prompt" role="status">
      <span>{p.msg}</span>
      {p.action && <button onClick={p.action.run}>{p.action.label}</button>}
      <button className="icon" title={t("app.close")} onClick={() => hidePrompt(p.id)}>{Icon.close}</button>
    </div>
  );
}

function Toast() {
  const msg = useShell((s) => s.toast);
  return msg ? <div className="toast">{msg}</div> : null;
}
