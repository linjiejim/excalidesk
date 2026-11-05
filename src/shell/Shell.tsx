import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./shell.css";
import { Editor } from "./Editor";
import { basename, inTauri, ipc, isICloud, type TreeNode } from "./ipc";
import { setState, useShell, getState, type Tab } from "./store";
import {
  boot, closeApp, closeTab, cycleTab, exportActive, flushAll, newDoc, onFsChanged, openFileDialog,
  openPath, activate, pickRoot, refreshSync, removeRoot, revealActive, sessions, useICloudRoot,
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
    case "reveal": return revealActive();
    case "close_tab": return active ? closeTab(active) : closeApp();
    case "toggle_sidebar": return setState((s) => ({ sidebar: !s.sidebar }));
    case "focus_mode": return setState((s) => ({ focus: !s.focus }));
    case "next_tab": return cycleTab(1);
    case "prev_tab": return cycleTab(-1);
  }
}

export default function Shell() {
  const theme = useSystemTheme();
  const sidebar = useShell((s) => s.sidebar && !s.focus);
  const focus = useShell((s) => s.focus);

  useEffect(() => {
    const un: Promise<() => void>[] = !inTauri ? [] : [
      listen<string>("menu", (e) => onMenu(e.payload)),
      listen<string[]>("fs-changed", (e) => onFsChanged(e.payload)),
      listen<string[]>("open-paths", (e) => e.payload.forEach(openPath)),
      listen("app-close-requested", () => closeApp()),
    ];
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
    <div className={`shell ${theme}`}>
      {sidebar && <Sidebar />}
      <main>
        {!focus && <TabBar />}
        <EditorArea theme={theme} />
        {!focus && <StatusBar />}
      </main>
      <Toast />
    </div>
  );
}

// ── 侧边栏 ─────────────────────────────────────────────

function Sidebar() {
  const roots = useShell((s) => s.roots);
  const recent = useShell((s) => s.recent);
  const outside = recent.filter((p) => !roots.some((r) => p.startsWith(r + "/"))).slice(0, 6);
  return (
    <aside className="sidebar">
      <div className="side-head">
        <span>工作区</span>
        <button className="icon" title="添加文件夹（⇧⌘O）" onClick={pickRoot}>＋</button>
      </div>
      <div className="side-scroll">
        {roots.map((r) => <RootSection key={r} root={r} />)}
        {roots.length === 0 && <div className="muted pad">还没有工作区。添加一个文件夹，里面的 .excalidraw 都会列在这里。</div>}
        {outside.length > 0 && (
          <>
            <div className="sec">最近打开的其他文件</div>
            {outside.map((p) => <FileRow key={p} path={p} name={basename(p)} depth={0} dataless={false} />)}
          </>
        )}
      </div>
    </aside>
  );
}

function RootSection({ root }: { root: string }) {
  const nodes = useShell((s) => s.trees[root]);
  const [open, setOpen] = useState(true);
  const label = isICloud(root) ? `iCloud · ${basename(root)}` : basename(root);
  return (
    <div className="root">
      <div className="row root-row" onClick={() => setOpen(!open)} title={prettyPath(root)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="grow ellipsis">{label}</span>
        <button className="icon hover-only" title="从侧边栏移除（不删文件）" onClick={(e) => { e.stopPropagation(); removeRoot(root); }}>×</button>
      </div>
      {open && (nodes?.length ? nodes.map((n) => <TreeItem key={n.path} node={n} depth={1} />) : <div className="muted row" style={{ paddingLeft: 26 }}>{nodes ? "没有 .excalidraw 文件" : "读取中…"}</div>)}
    </div>
  );
}

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(true);
  if (!node.dir) return <FileRow path={node.path} name={node.name} depth={depth} dataless={node.dataless} />;
  return (
    <>
      <div className="row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen(!open)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="ellipsis">{node.name}</span>
      </div>
      {open && node.children?.map((c) => <TreeItem key={c.path} node={c} depth={depth + 1} />)}
    </>
  );
}

function FileRow({ path, name, depth, dataless }: { path: string; name: string; depth: number; dataless: boolean }) {
  const active = useShell((s) => s.active === path);
  return (
    <div className={`row file ${active ? "on" : ""}`} style={{ paddingLeft: 22 + depth * 14 }} onClick={() => openPath(path)} title={prettyPath(path)}>
      <span className="grow ellipsis">{name}</span>
      {dataless && <span className="muted" title="仅在 iCloud，打开时下载">☁︎</span>}
    </div>
  );
}

// ── 标签栏 / 状态栏 ────────────────────────────────────

function TabBar() {
  const tabs = useShell((s) => s.tabs);
  const active = useShell((s) => s.active);
  if (!tabs.length) return <div className="tabbar empty" />;
  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div key={t.path} className={`tab ${t.path === active ? "on" : ""}`} onClick={() => activate(t.path)} onAuxClick={(e) => e.button === 1 && closeTab(t.path)} title={prettyPath(t.path)}>
          <span className="ellipsis">{t.title}</span>
          {t.save === "error" ? <span className="err">!</span> : t.save !== "saved" ? <span className="dot" /> : null}
          <button className="icon close" onClick={(e) => { e.stopPropagation(); closeTab(t.path); }} title="关闭（⌘W）">×</button>
        </div>
      ))}
      <button className="icon" title="新建图（⌘N）" onClick={newDoc}>＋</button>
    </div>
  );
}

const time = (t?: number) => (t ? new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "");

function saveText(t: Tab) {
  if (t.phase === "loading") return "正在打开…";
  if (t.phase === "downloading") return "正在从 iCloud 下载…";
  if (t.phase === "error") return "打不开";
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
  if (!tab) return <div className="statusbar" />;
  let syncText = "";
  if (sync?.ubiquitous) {
    syncText = sync.conflict ? "iCloud 有冲突版本" : sync.uploading ? "正在上传到 iCloud" : sync.uploaded ? "iCloud 已同步" : "等待上传到 iCloud";
  }
  return (
    <div className="statusbar">
      <span className={tab.save === "error" ? "err" : ""}>{saveText(tab)}</span>
      {syncText && <span>{syncText}</span>}
      {tab.phase === "ready" && <span>{tab.elements} 个元素</span>}
      <span className="grow" />
      <span className="ellipsis path">{prettyPath(tab.path)}</span>
    </div>
  );
}

// ── 编辑区 ─────────────────────────────────────────────

function EditorArea({ theme }: { theme: "light" | "dark" }) {
  const tab = useShell((s) => s.tabs.find((t) => t.path === s.active));
  if (!tab) return <Welcome />;
  const session = sessions.get(tab.path);
  return (
    <div className="editor">
      {tab.banner && (
        <div className="banner">
          <span>{tab.banner}</span>
          <span className="muted">⌘Z 可撤销合并</span>
          <button className="icon" onClick={() => setState((s) => ({ tabs: s.tabs.map((t) => (t.path === tab.path ? { ...t, banner: undefined } : t)) }))}>×</button>
        </div>
      )}
      {tab.phase === "ready" && session ? (
        <Editor session={session} theme={theme} />
      ) : (
        <div className="placeholder">
          {tab.phase === "error" ? (
            <>
              <div>打不开「{tab.title}」</div>
              <div className="muted">{tab.error}</div>
              <button onClick={() => { closeTab(tab.path).then(() => openPath(tab.path)); }}>重试</button>
            </>
          ) : (
            <div className="muted">{tab.phase === "downloading" ? "正在从 iCloud 下载…" : "正在打开…"}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Welcome() {
  const roots = useShell((s) => s.roots);
  const recent = useShell((s) => s.recent).slice(0, 8);
  if (!roots.length) {
    return (
      <div className="welcome">
        <h1>图存在哪</h1>
        <p className="muted">文件就是标准 .excalidraw，excalidraw.com、Obsidian 插件都能直接打开。</p>
        <div className="cards">
          <button className="card primary" onClick={useICloudRoot}>
            <b>iCloud Drive</b>
            <span className="muted">在 iCloud Drive 里建一个「Excalidraw」文件夹，在你的 Mac 之间自动同步。</span>
          </button>
          <button className="card" onClick={pickRoot}>
            <b>本地文件夹</b>
            <span className="muted">选任意文件夹，适合放进 git 仓库或其他同步盘。</span>
          </button>
        </div>
        <p className="muted small">之后还可以在侧边栏添加更多文件夹。</p>
      </div>
    );
  }
  return (
    <div className="welcome">
      <div className="actions">
        <button onClick={newDoc}>新建图 <kbd>⌘N</kbd></button>
        <button onClick={openFileDialog}>打开… <kbd>⌘O</kbd></button>
      </div>
      {recent.length > 0 && (
        <div className="recent">
          <div className="sec">最近打开</div>
          {recent.map((p) => (
            <div key={p} className="row file" onClick={() => openPath(p)}>
              <span className="grow ellipsis">{basename(p)}</span>
              <span className="muted ellipsis small">{prettyPath(p.slice(0, p.lastIndexOf("/")))}</span>
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
