//! App 里的 MCP 宿主：监听 Unix socket，一条连接 = 一个 Agent。
//!
//! - 工具调用并发执行，多个 Agent 各改各的图互不等待；同一张图的写入由前端按文件排队。
//! - 读：先让前端把未保存的改动存下来，再从 DocStore（打开中）或磁盘读，压成精简场景。
//! - 写：交给前端（转换元素、放进画布、可撤销、正常保存），完成后把 Agent 自己写的元素并进基线。
//! - 基线 = Agent 上次看到的样子，按文件存在 mcp/baselines/ 下，重启 App 后 get_feedback 仍能列出改动。
//! - 「发回」：唤醒在 wait_for_feedback 上等这张图的 Agent；没人在等就记下来，并试着推进它的会话（channels）。

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{mpsc, oneshot, watch},
};

use super::{
    scene::{self, Baseline, Scene},
    socket_path, DeleteArgs, Down, DrawArgs, FeedbackArgs, ListArgs, MermaidArgs, OpenArgs, ReadArgs, RenderArgs, ResolveArgs, Up, UpdateArgs,
    WaitArgs,
};
use crate::{
    doc::{self, Doc, DocStore},
    workspace::{self, StateFile},
};

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Clone, Serialize)]
pub struct AgentView {
    pub id: u64,
    pub name: String,
    /// idle | working | waiting
    pub status: String,
    pub tool: Option<String>,
    /// 最近一次操作的图
    pub path: Option<String>,
    /// 这次连接里碰过的图
    pub files: Vec<String>,
    pub since: u64,
    pub last: u64,
}

struct Agent {
    view: AgentView,
    tx: mpsc::UnboundedSender<Down>,
}

struct Waiter {
    agent: u64,
    path: Option<PathBuf>,
    tx: oneshot::Sender<PathBuf>,
}

#[derive(Serialize)]
pub struct SendResult {
    /// 正在 wait_for_feedback、已经收到的 Agent
    pub woke: Vec<String>,
    /// 没在等，试着推进会话的 Agent（只有开了 channels 的 Claude Code 会话收得到）
    pub pushed: Vec<String>,
}

pub struct Host {
    app: AppHandle,
    dir: PathBuf,
    enabled: AtomicBool,
    next_agent: AtomicU64,
    agents: Mutex<HashMap<u64, Agent>>,
    /// (Agent 名, 图) → 它上次看到的样子：两个 Agent 改同一张图时各看各的
    baselines: Mutex<HashMap<(String, PathBuf), Baseline>>,
    /// 图 → 用户最近一次点「发回」的时间
    sent: Mutex<HashMap<PathBuf, u64>>,
    /// (Agent 名, 图) → 这个 Agent 已经收到的那次「发回」；sent 比它新才算有新反馈
    sent_seen: Mutex<HashMap<(String, PathBuf), u64>>,
    waiters: Mutex<Vec<Waiter>>,
    front_next: AtomicU64,
    front_pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    front_ready: watch::Sender<bool>,
}

fn text(t: impl Into<String>) -> Value {
    json!({ "type": "text", "text": t.into() })
}
fn pretty(v: &Value) -> Value {
    text(serde_json::to_string_pretty(v).unwrap_or_default())
}
fn parse<T: DeserializeOwned>(mut v: Value) -> Result<T, String> {
    unstringify(&mut v);
    serde_json::from_value(v).map_err(|e| format!("invalid arguments: {e}"))
}

/// 模型常把嵌套参数再编码成 JSON 字符串（`"elements": "[…]"` 或 `["{…}", …]`）：拆回来，别让整次调用失败
fn unstringify(args: &mut Value) {
    let Some(obj) = args.as_object_mut() else { return };
    for (k, v) in obj.iter_mut() {
        let nested = matches!(k.as_str(), "elements" | "updates" | "comments" | "ids" | "at");
        if let Value::String(s) = v {
            let t = s.trim_start();
            if nested && (t.starts_with('[') || t.starts_with('{')) {
                if let Ok(p) = serde_json::from_str::<Value>(s) {
                    *v = p;
                }
            }
        }
        if let Value::Array(items) = v {
            for it in items.iter_mut() {
                if let Value::String(s) = it {
                    if s.trim_start().starts_with('{') {
                        if let Ok(p @ Value::Object(_)) = serde_json::from_str::<Value>(s) {
                            *it = p;
                        }
                    }
                }
            }
        }
    }
}

/// 还不存在的文件夹的真实路径：最近一层存在的祖先 canonicalize，再接上还没建的那几段（不许 `..`）
fn real_new_dir(dir: &Path) -> Result<PathBuf, String> {
    let mut base = dir.to_path_buf();
    let mut rest = vec![];
    while !base.exists() {
        match (base.file_name(), base.parent()) {
            (Some(n), Some(parent)) => {
                rest.push(n.to_os_string());
                base = parent.to_path_buf();
            }
            _ => return Err(format!("{} isn't a usable folder", dir.display())),
        }
    }
    let mut real = std::fs::canonicalize(&base).map_err(|e| format!("{}: {e}", dir.display()))?;
    for n in rest.iter().rev() {
        real.push(n);
    }
    Ok(real)
}

fn display_name(client: &Value) -> String {
    let name = client.get("name").and_then(Value::as_str).unwrap_or("Agent");
    let title = client.get("title").and_then(Value::as_str);
    match name {
        "claude-code" => "Claude Code".into(),
        "claude-ai" => "Claude".into(),
        n if n.starts_with("codex") => "Codex".into(),
        n => title.unwrap_or(n).to_string(),
    }
}

/// 工具调用期间把 Agent 标成忙；调用结束（含被取消）恢复空闲
struct Busy<'a> {
    host: &'a Host,
    agent: u64,
}
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.host.set_status(self.agent, "idle", None);
    }
}

impl Host {
    pub fn new(app: AppHandle, dir: PathBuf, enabled: bool) -> Arc<Self> {
        Arc::new(Self {
            app,
            dir,
            enabled: AtomicBool::new(enabled),
            next_agent: AtomicU64::new(1),
            agents: Default::default(),
            baselines: Default::default(),
            sent: Default::default(),
            sent_seen: Default::default(),
            waiters: Default::default(),
            front_next: AtomicU64::new(1),
            front_pending: Default::default(),
            front_ready: watch::Sender::new(false),
        })
    }

    // ── socket ──────────────────────────────────────────

    pub async fn listen(self: Arc<Self>) {
        let path = socket_path();
        if let Some(d) = path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        if path.exists() {
            // 另一个 Excalidesk（比如开发版和正式版同时开着）已经在服务：让给它
            if UnixStream::connect(&path).await.is_ok() {
                eprintln!("[mcp] another Excalidesk is already serving {}", path.display());
                return;
            }
            let _ = std::fs::remove_file(&path);
        }
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[mcp] can't listen on {}: {e}", path.display());
                return;
            }
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        loop {
            if let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(self.clone().serve(stream));
            }
        }
    }

    async fn serve(self: Arc<Self>, stream: UnixStream) {
        let (read, mut write) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Down>();
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                let mut line = serde_json::to_vec(&m).unwrap_or_default();
                line.push(b'\n');
                if write.write_all(&line).await.is_err() {
                    break;
                }
            }
        });
        let id = self.next_agent.fetch_add(1, Ordering::SeqCst);
        let now = now_ms();
        let view = AgentView { id, name: "Agent".into(), status: "idle".into(), tool: None, path: None, files: vec![], since: now, last: now };
        self.agents.lock().unwrap().insert(id, Agent { view, tx: tx.clone() });
        self.emit_agents();
        let mut tasks: HashMap<u64, tokio::task::AbortHandle> = HashMap::new();
        let mut lines = BufReader::new(read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            match serde_json::from_str::<Up>(&line) {
                Ok(Up::Hello { client }) => self.name_agent(id, &client),
                Ok(Up::Call { id: call, tool, args }) => {
                    tasks.retain(|_, t| !t.is_finished());
                    let host = self.clone();
                    let tx = tx.clone();
                    let task = tokio::spawn(async move {
                        let msg = match host.call(id, &tool, args).await {
                            Ok(content) => Down::Result { id: call, content, error: false },
                            Err(e) => Down::Result { id: call, content: vec![text(e)], error: true },
                        };
                        let _ = tx.send(msg);
                    });
                    tasks.insert(call, task.abort_handle());
                }
                Ok(Up::Cancel { id: call }) => {
                    if let Some(t) = tasks.remove(&call) {
                        t.abort();
                    }
                }
                Err(_) => {}
            }
        }
        for t in tasks.values() {
            t.abort();
        }
        self.agents.lock().unwrap().remove(&id);
        self.waiters.lock().unwrap().retain(|w| w.agent != id);
        writer.abort();
        self.emit_agents();
    }

    fn name_agent(&self, id: u64, client: &Value) {
        let base = display_name(client);
        {
            let mut agents = self.agents.lock().unwrap();
            let taken: HashSet<String> = agents.values().filter(|a| a.view.id != id).map(|a| a.view.name.clone()).collect();
            let mut name = base.clone();
            let mut n = 2;
            while taken.contains(&name) {
                name = format!("{base} {n}");
                n += 1;
            }
            if let Some(a) = agents.get_mut(&id) {
                a.view.name = name;
            }
        }
        self.emit_agents();
    }

    // ── 状态 ────────────────────────────────────────────

    pub fn views(&self) -> Vec<AgentView> {
        let mut v: Vec<AgentView> = self.agents.lock().unwrap().values().map(|a| a.view.clone()).collect();
        v.sort_by_key(|a| a.id);
        v
    }

    fn emit_agents(&self) {
        let _ = self.app.emit("mcp-agents", self.views());
    }

    fn agent_name(&self, id: u64) -> String {
        self.agents.lock().unwrap().get(&id).map(|a| a.view.name.clone()).unwrap_or_else(|| "Agent".into())
    }

    fn set_status(&self, id: u64, status: &str, tool: Option<&str>) {
        if let Some(a) = self.agents.lock().unwrap().get_mut(&id) {
            a.view.status = status.into();
            a.view.tool = tool.map(String::from);
            a.view.last = now_ms();
        }
        self.emit_agents();
    }

    fn touch(&self, id: u64, path: &Path) {
        let p = path.display().to_string();
        if let Some(a) = self.agents.lock().unwrap().get_mut(&id) {
            a.view.files.retain(|f| f != &p);
            a.view.files.insert(0, p.clone());
            a.view.path = Some(p);
            a.view.last = now_ms();
        }
        // 第一次碰这张图：在那之前的「发回」不是给它的
        let key = self.key(id, path);
        let last = self.sent.lock().unwrap().get(path).copied().unwrap_or(0);
        self.sent_seen.lock().unwrap().entry(key).or_insert(last);
        self.emit_agents();
    }

    fn key(&self, agent: u64, p: &Path) -> (String, PathBuf) {
        (self.agent_name(agent), p.to_path_buf())
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
    }
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    // ── 前端 RPC ────────────────────────────────────────

    pub fn set_ready(&self) {
        self.front_ready.send_replace(true);
    }

    async fn front(&self, op: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        let mut ready = self.front_ready.subscribe();
        if !*ready.borrow() {
            tokio::time::timeout(Duration::from_secs(30), ready.wait_for(|r| *r))
                .await
                .map_err(|_| "Excalidesk's window isn't ready yet. Try again in a moment.".to_string())?
                .map_err(|e| e.to_string())?;
        }
        let id = self.front_next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.front_pending.lock().unwrap().insert(id, tx);
        self.app.emit("mcp-call", json!({ "id": id, "op": op, "args": args })).map_err(|e| e.to_string())?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("Excalidesk's window went away.".into()),
            Err(_) => {
                self.front_pending.lock().unwrap().remove(&id);
                Err(format!("Excalidesk didn't finish `{op}` in time."))
            }
        }
    }

    pub fn reply(&self, id: u64, ok: bool, value: Value) {
        if let Some(tx) = self.front_pending.lock().unwrap().remove(&id) {
            let _ = tx.send(if ok { Ok(value) } else { Err(value.as_str().map(String::from).unwrap_or_else(|| value.to_string())) });
        }
    }

    // ── 路径 ────────────────────────────────────────────

    fn roots(&self) -> Vec<PathBuf> {
        self.app.state::<StateFile>().snapshot().roots.into_iter().map(PathBuf::from).collect()
    }

    fn is_open(&self, p: &Path) -> bool {
        self.app.state::<DocStore>().0.lock().unwrap().contains_key(p)
    }

    fn allowed(&self, p: &Path) -> Result<(), String> {
        let inside = self.roots().iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|r| p.starts_with(&r));
        if inside || self.is_open(p) {
            Ok(())
        } else {
            Err(format!(
                "{} is outside the Excalidesk workspace folders. Agents can only use drawings inside them (list_drawings shows them) or drawings open in a tab.",
                p.display()
            ))
        }
    }

    fn expand(&self, p: &str) -> Result<PathBuf, String> {
        let p = p.trim();
        if let Some(rest) = p.strip_prefix("~/") {
            return Ok(PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest));
        }
        let pb = PathBuf::from(p);
        if pb.is_absolute() {
            return Ok(pb);
        }
        let roots = self.roots();
        roots
            .iter()
            .map(|r| r.join(&pb))
            .find(|c| c.exists())
            .or_else(|| roots.first().map(|r| r.join(&pb)))
            .ok_or_else(|| "Excalidesk has no workspace folder yet. Ask the user to add one (sidebar → Add Folder).".to_string())
    }

    /// 绝对路径或相对工作区的路径 → 规范化的绝对路径（必须在工作区内或已经打开）
    fn resolve(&self, p: &str) -> Result<PathBuf, String> {
        let mut s = p.trim().to_string();
        if !s.ends_with(".excalidraw") {
            s.push_str(".excalidraw");
        }
        let cand = self.expand(&s)?;
        let real = std::fs::canonicalize(&cand)
            .map_err(|_| format!("{} doesn't exist. Use list_drawings to find drawings, or open_drawing with `create`.", cand.display()))?;
        self.allowed(&real)?;
        Ok(real)
    }

    async fn load(&self, path: &Path) -> Result<Vec<Value>, String> {
        if self.is_open(path) {
            // 先把编辑中、还没存的改动存下来
            let _ = self.front("flush", json!({ "path": path }), Duration::from_secs(20)).await;
        }
        if let Some(els) = self.app.state::<DocStore>().0.lock().unwrap().get(path).map(Doc::elements) {
            return Ok(els);
        }
        let p = path.to_path_buf();
        let bytes = tauri::async_runtime::spawn_blocking(move || doc::read_file(&p)).await.map_err(|e| e.to_string())??;
        Ok(Doc::parse(&bytes)?.elements())
    }

    async fn scene(&self, path: &Path) -> Result<Scene, String> {
        Ok(scene::simplify(&self.load(path).await?))
    }

    // ── 基线 ────────────────────────────────────────────

    fn base_file(&self, (name, p): &(String, PathBuf)) -> PathBuf {
        let h = Sha256::digest(format!("{name}\n{}", p.display()).as_bytes());
        let hex: String = h.iter().take(12).map(|b| format!("{b:02x}")).collect();
        self.dir.join("baselines").join(format!("{hex}.json"))
    }

    fn get_base(&self, agent: u64, p: &Path) -> Option<Baseline> {
        let key = self.key(agent, p);
        if let Some(b) = self.baselines.lock().unwrap().get(&key) {
            return Some(b.clone());
        }
        let b: Baseline = serde_json::from_slice(&std::fs::read(self.base_file(&key)).ok()?).ok()?;
        self.baselines.lock().unwrap().insert(key, b.clone());
        Some(b)
    }

    fn put_base(&self, agent: u64, p: &Path, b: Baseline) {
        let key = self.key(agent, p);
        let f = self.base_file(&key);
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(&f, serde_json::to_vec(&b).unwrap_or_default());
        self.baselines.lock().unwrap().insert(key, b);
    }

    // ── 工具 ────────────────────────────────────────────

    async fn call(self: &Arc<Self>, agent: u64, tool: &str, args: Value) -> Result<Vec<Value>, String> {
        if !self.enabled() {
            return Err("Agent access is turned off in Excalidesk (Settings → Agents).".into());
        }
        self.set_status(agent, if tool == "wait_for_feedback" { "waiting" } else { "working" }, Some(tool));
        let _busy = Busy { host: self, agent };
        match tool {
            "list_drawings" => self.list(parse(args)?).await,
            "open_drawing" => self.open(agent, parse(args)?).await,
            "read_drawing" => self.read(agent, parse(args)?).await,
            "render_drawing" => {
                let a: RenderArgs = parse(args)?;
                let path = self.resolve(&a.path)?;
                self.render(&path, a).await
            }
            "draw" => {
                let a: DrawArgs = parse(args)?;
                let path = self.resolve(&a.path)?;
                self.write(agent, "draw", &path, serde_json::to_value(a).unwrap_or_default()).await
            }
            "draw_mermaid" => {
                let a: MermaidArgs = parse(args)?;
                let path = self.resolve(&a.path)?;
                self.write(agent, "mermaid", &path, serde_json::to_value(a).unwrap_or_default()).await
            }
            "update_elements" => {
                let a: UpdateArgs = parse(args)?;
                let path = self.resolve(&a.path)?;
                self.write(agent, "update", &path, serde_json::to_value(a).unwrap_or_default()).await
            }
            "delete_elements" => {
                let a: DeleteArgs = parse(args)?;
                let path = self.resolve(&a.path)?;
                self.write(agent, "delete", &path, serde_json::to_value(a).unwrap_or_default()).await
            }
            "resolve_comments" => {
                let a: ResolveArgs = parse(args)?;
                let path = self.resolve(&a.path)?;
                self.write(agent, "resolve", &path, serde_json::to_value(a).unwrap_or_default()).await
            }
            "get_feedback" => {
                let a: FeedbackArgs = parse(args)?;
                let path = self.resolve(&a.path)?;
                self.feedback(agent, &path, a.render.unwrap_or(false)).await
            }
            "wait_for_feedback" => self.wait(agent, parse(args)?).await,
            _ => Err(format!("unknown tool {tool}")),
        }
    }

    async fn list(&self, a: ListArgs) -> Result<Vec<Value>, String> {
        let roots = self.roots();
        let q = a.query.map(|q| q.to_lowercase());
        let scan_roots = roots.clone();
        let mut items: Vec<(PathBuf, u64)> = tauri::async_runtime::spawn_blocking(move || {
            scan_roots
                .iter()
                .flat_map(|r| workspace::all_docs(r))
                .map(|p| {
                    let m = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                    (p, m)
                })
                .collect()
        })
        .await
        .map_err(|e| e.to_string())?;
        if let Some(q) = &q {
            items.retain(|(p, _)| p.display().to_string().to_lowercase().contains(q));
        }
        items.sort_by(|a, b| b.1.cmp(&a.1));
        let total = items.len();
        items.truncate(200);
        let now = now_ms() / 1000;
        let ago = |t: u64| {
            let d = now.saturating_sub(t);
            match d {
                0..=59 => "just now".to_string(),
                60..=3599 => format!("{}m ago", d / 60),
                3600..=86399 => format!("{}h ago", d / 3600),
                _ => format!("{}d ago", d / 86400),
            }
        };
        let open: Vec<String> = self.app.state::<DocStore>().0.lock().unwrap().keys().map(|p| p.display().to_string()).collect();
        let mut v = json!({
            "workspaces": roots,
            "drawings": items.iter().map(|(p, t)| json!({ "path": p, "modified": ago(*t) })).collect::<Vec<_>>(),
            "open_tabs": open,
        });
        if total > 200 {
            v["truncated"] = json!(format!("{total} drawings; showing the newest 200. Pass `query` to narrow it down."));
        }
        Ok(vec![pretty(&v)])
    }

    async fn open(&self, agent: u64, a: OpenArgs) -> Result<Vec<Value>, String> {
        let (path, created) = match (a.create, a.path) {
            (Some(name), _) => {
                let name = name.trim().trim_end_matches(".excalidraw").to_string();
                if name.is_empty() || name.contains('/') {
                    return Err("`create` is a file name without folders; use `dir` for the folder.".into());
                }
                let dir = match a.dir {
                    Some(d) => self.expand(&d)?,
                    None => self.roots().into_iter().next().ok_or("Excalidesk has no workspace folder yet. Ask the user to add one (sidebar → Add Folder).")?,
                };
                // 先判断再建文件夹：工作区外的路径一个目录也不建
                let real_dir = real_new_dir(&dir)?;
                self.allowed(&real_dir.join("x"))?;
                let p = tauri::async_runtime::spawn_blocking(move || {
                    // 两个 Agent 同时新建同名的图：挑名字和写文件一起锁住，各拿一个编号
                    static CREATE: Mutex<()> = Mutex::new(());
                    let _g = CREATE.lock().unwrap_or_else(|e| e.into_inner());
                    std::fs::create_dir_all(&real_dir).map_err(|e| e.to_string())?;
                    let p = workspace::unique_name(&real_dir, &name);
                    doc::write_file(&p, &Doc::default().serialize())?;
                    Ok::<_, String>(p)
                })
                .await
                .map_err(|e| e.to_string())??;
                (p, true)
            }
            (None, Some(p)) => (self.resolve(&p)?, false),
            (None, None) => return Err("Pass `path` to open a drawing, or `create` to make a new one.".into()),
        };
        self.front("open", json!({ "path": path, "focus": a.focus.unwrap_or(false) }), Duration::from_secs(90)).await?;
        let scene = self.scene(&path).await?;
        if created {
            self.put_base(agent, &path, scene.baseline(now_ms()));
        }
        self.touch(agent, &path);
        let frames: Vec<Value> = scene.elements.iter().filter(|e| e.kind == "frame").map(|f| json!({ "id": f.id, "name": f.name })).collect();
        Ok(vec![pretty(&json!({
            "path": path,
            "created": created,
            "elements": scene.elements.len(),
            "comments": scene.comments.iter().filter(|c| c.status != "resolved").count(),
            "frames": frames,
        }))])
    }

    async fn read(&self, agent: u64, a: ReadArgs) -> Result<Vec<Value>, String> {
        let path = self.resolve(&a.path)?;
        let full = self.scene(&path).await?;
        let mut scene = full.clone();
        if let Some(f) = &a.frame {
            scene.only_frame(f)?;
            // 只看了一个 frame：只把这部分记成看过
            let mut base = self.get_base(agent, &path).unwrap_or_else(|| full.baseline(now_ms()));
            let ids: HashSet<String> = scene.elements.iter().map(|e| e.id.clone()).chain(scene.comments.iter().map(|c| c.id.clone())).collect();
            scene::absorb(&mut base, &full, &ids);
            self.put_base(agent, &path, base);
        } else {
            self.put_base(agent, &path, full.baseline(now_ms()));
        }
        self.touch(agent, &path);
        let mut v = scene::overview(&scene, 400);
        v["path"] = json!(path);
        Ok(vec![text(serde_json::to_string(&v).unwrap_or_default())])
    }

    async fn render(&self, path: &Path, a: RenderArgs) -> Result<Vec<Value>, String> {
        let mut args = serde_json::to_value(&a).unwrap_or_default();
        args["path"] = json!(path);
        if !self.is_open(path) {
            let p = path.to_path_buf();
            let bytes = tauri::async_runtime::spawn_blocking(move || doc::read_file(&p)).await.map_err(|e| e.to_string())??;
            args["scene"] = json!(String::from_utf8_lossy(&bytes));
        }
        let r = self.front("render", args, Duration::from_secs(60)).await?;
        let png = r.get("png").and_then(Value::as_str).ok_or("render returned nothing")?;
        Ok(vec![
            json!({ "type": "image", "data": png, "mimeType": "image/png" }),
            text(format!("{}×{} px", r["width"], r["height"])),
        ])
    }

    /// 写操作：前端执行，返回 {ids:[碰过的元素], ...}；Agent 自己写的元素并进基线，不算用户的改动
    async fn write(&self, agent: u64, op: &str, path: &Path, mut args: Value) -> Result<Vec<Value>, String> {
        args["path"] = json!(path);
        args["agent"] = json!(self.agent_name(agent));
        let r = self.front(op, args, Duration::from_secs(120)).await?;
        let ids: HashSet<String> = r.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
        let now = self.scene(path).await?;
        let base = match self.get_base(agent, path) {
            Some(mut b) => {
                scene::absorb(&mut b, &now, &ids);
                b
            }
            None => now.baseline(now_ms()),
        };
        self.put_base(agent, path, base);
        self.touch(agent, path);
        Ok(vec![pretty(&r)])
    }

    async fn feedback(&self, agent: u64, path: &Path, render: bool) -> Result<Vec<Value>, String> {
        // 先记下此刻最近一次「发回」，再读场景：读的过程中用户又点了「发回」，那一次留给下一轮
        let sent_at = self.sent.lock().unwrap().get(path).copied();
        let now = self.scene(path).await?;
        let base = self.get_base(agent, path);
        let mut fb = scene::feedback(base.as_ref(), &now);
        // 这次「发回」算这个 Agent 收到了；别的 Agent 各自还能收到
        let sent = {
            let mut seen = self.sent_seen.lock().unwrap();
            let key = self.key(agent, path);
            match sent_at {
                Some(t) if t > seen.get(&key).copied().unwrap_or(0) => {
                    seen.insert(key, t);
                    true
                }
                _ => false,
            }
        };
        fb["path"] = json!(path);
        fb["sent"] = json!(sent);
        let open = fb["comments"].as_array().map(Vec::len).unwrap_or(0);
        let changes = ["added", "modified", "removed"].iter().map(|k| fb["changes"][k].as_array().map(Vec::len).unwrap_or(0)).sum::<usize>();
        fb["summary"] = json!(format!("{open} open comment(s), {changes} change(s) since you last looked."));
        self.put_base(agent, path, now.baseline(now_ms()));
        self.touch(agent, path);
        let _ = self.app.emit("mcp-feedback-read", json!({ "path": path, "agent": self.agent_name(agent) }));
        let mut out = vec![pretty(&fb)];
        if render {
            let r = RenderArgs { path: path.display().to_string(), frame: None, ids: None, max_size: None, comments: Some(true) };
            if let Ok(img) = self.render(path, r).await {
                out.extend(img);
            }
        }
        Ok(out)
    }

    async fn wait(&self, agent: u64, a: WaitArgs) -> Result<Vec<Value>, String> {
        let path = a.path.as_deref().map(|p| self.resolve(p)).transpose()?;
        if let Some(p) = &path {
            self.touch(agent, p);
        }
        let name = self.agent_name(agent);
        // 查有没有新的「发回」和登记等待在同一把 sent 锁里：send() 先记 sent 再唤醒，插不进两步中间
        let ready = {
            let sent = self.sent.lock().unwrap();
            let seen = self.sent_seen.lock().unwrap();
            let pending = |p: &Path| sent.get(p).is_some_and(|t| *t > seen.get(&(name.clone(), p.to_path_buf())).copied().unwrap_or(0));
            let hit = match &path {
                Some(p) => pending(p).then(|| p.clone()),
                None => {
                    let files = self.agents.lock().unwrap().get(&agent).map(|a| a.view.files.clone()).unwrap_or_default();
                    files.iter().map(PathBuf::from).find(|f| pending(f))
                }
            };
            match hit {
                Some(p) => Ok(p),
                None => {
                    let (tx, rx) = oneshot::channel();
                    self.waiters.lock().unwrap().push(Waiter { agent, path: path.clone(), tx });
                    Err(rx)
                }
            }
        };
        let target = match ready {
            Ok(p) => p,
            Err(rx) => {
                self.emit_agents();
                let secs = a.timeout_seconds.unwrap_or(1500).clamp(5, 3600);
                let r = tokio::time::timeout(Duration::from_secs(secs), rx).await;
                self.waiters.lock().unwrap().retain(|w| !w.tx.is_closed());
                match r {
                    Ok(Ok(p)) => p,
                    _ => {
                        return Ok(vec![text(
                            "No feedback yet: the user hasn't pressed \"Send to agent\" in Excalidesk. Call wait_for_feedback again to keep waiting, or get_feedback to look now.",
                        )])
                    }
                }
            }
        };
        self.feedback(agent, &target, a.render.unwrap_or(true)).await
    }

    /// 用户点「发回给 Agent」
    pub async fn send(&self, path: PathBuf) -> SendResult {
        self.sent.lock().unwrap().insert(path.clone(), now_ms());
        let p = path.display().to_string();
        let touched = |a: &Agent| a.view.files.contains(&p);
        let mut woke = vec![];
        let mut woke_ids = HashSet::new();
        {
            let agents = self.agents.lock().unwrap();
            let mut ws = self.waiters.lock().unwrap();
            let mut keep = vec![];
            for w in ws.drain(..) {
                let hit = match &w.path {
                    Some(wp) => wp == &path,
                    None => agents.get(&w.agent).is_some_and(touched),
                };
                if hit {
                    let name = agents.get(&w.agent).map(|a| a.view.name.clone()).unwrap_or_default();
                    if w.tx.send(path.clone()).is_ok() && woke_ids.insert(w.agent) {
                        woke.push(name);
                    }
                } else {
                    keep.push(w);
                }
            }
            *ws = keep;
        }
        // 碰过这张图、但这次没在等的 Agent：推一条提醒（有人被唤醒也照推，各是各的会话）
        let mut pushed = vec![];
        let idle = self.agents.lock().unwrap().values().any(|a| touched(a) && !woke_ids.contains(&a.view.id));
        if idle {
            let open = self.scene(&path).await.map(|s| s.comments.iter().filter(|c| c.status != "resolved").count()).unwrap_or(0);
            let file = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            let content = format!(
                "The user pressed \"Send to agent\" in Excalidesk for {file} ({open} open comment(s)). Call get_feedback with path \"{p}\" to see their comments and edits."
            );
            for a in self.agents.lock().unwrap().values() {
                if touched(a) && !woke_ids.contains(&a.view.id) && a.tx.send(Down::Push { content: content.clone(), meta: json!({ "path": p }) }).is_ok() {
                    pushed.push(a.view.name.clone());
                }
            }
        }
        self.emit_agents();
        SendResult { woke, pushed }
    }
}

// ── 命令 ────────────────────────────────────────────────

#[tauri::command]
pub fn mcp_ready(host: State<Arc<Host>>) -> Vec<AgentView> {
    host.set_ready();
    host.views()
}

#[tauri::command]
pub fn mcp_reply(host: State<Arc<Host>>, id: u64, ok: bool, value: Value) {
    host.reply(id, ok, value);
}

#[tauri::command]
pub async fn mcp_send(host: State<'_, Arc<Host>>, path: String) -> Result<SendResult, String> {
    Ok(host.send(PathBuf::from(path)).await)
}

#[tauri::command]
pub fn mcp_info(host: State<Arc<Host>>) -> Value {
    json!({
        "exe": std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
        "socket": socket_path(),
        "enabled": host.enabled(),
        "agents": host.views(),
    })
}

#[tauri::command]
pub fn mcp_set_enabled(app: AppHandle, host: State<Arc<Host>>, on: bool) {
    host.set_enabled(on);
    app.state::<StateFile>().update(|d| d.mcp_disabled = !on);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stringified_nested_args_are_unwrapped() {
        let a: DrawArgs = parse(json!({
            "path": "x.excalidraw",
            "elements": ["{\"type\":\"rectangle\",\"id\":\"a\"}", { "type": "text", "text": "{not json" }],
            "at": "{\"x\": 1, \"y\": 2}",
        }))
        .unwrap();
        assert_eq!(a.elements[0]["id"], "a");
        assert_eq!(a.elements[1]["text"], "{not json");
        assert_eq!(a.at.map(|p| p.x), Some(1.0));
        let u: UpdateArgs = parse(json!({ "path": "x", "updates": "[{\"id\":\"a\",\"text\":\"[keep]\"}]" })).unwrap();
        assert_eq!(u.updates[0]["text"], "[keep]");
        // 普通字符串字段不动
        let r: ReadArgs = parse(json!({ "path": "[weird].excalidraw" })).unwrap();
        assert_eq!(r.path, "[weird].excalidraw");
    }

    #[test]
    fn new_dir_resolves_without_creating() {
        let t = std::env::temp_dir().join(format!("excalidesk-newdir-{}", std::process::id()));
        std::fs::create_dir_all(&t).unwrap();
        let real_t = std::fs::canonicalize(&t).unwrap();
        assert_eq!(real_new_dir(&t.join("a/b")).unwrap(), real_t.join("a/b"));
        assert!(!t.join("a").exists(), "must not create anything");
        // 不存在的目录里的 `..` 解析不了
        assert!(real_new_dir(&t.join("nope/../../x")).is_err());
        std::fs::remove_dir_all(&t).unwrap();
    }
}
