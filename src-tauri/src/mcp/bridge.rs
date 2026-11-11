//! `excalidesk --mcp`：Agent 拉起的 stdio MCP server，把工具调用转给正在运行的 App。
//!
//! - 握手、工具列表在这里答，不连 App；第一次调用工具才连，App 没开就拉起来。
//! - 协议版本封顶 2025-11-25：保留 initialize 会话；Claude Code 的 channels 也只认这种会话。
//! - 调用超过几秒就发进度通知，Claude Code 的空闲计时（stdio 30 分钟）不会把 wait_for_feedback 掐掉。

use std::{
    borrow::Cow,
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, CustomNotification, Implementation, ListToolsResult,
        PaginatedRequestParams, ProgressNotificationParam, ProtocolVersion, ServerCapabilities, ServerConfig, ServerNotification, Tool,
        ToolAnnotations,
    },
    service::RequestContext,
    ErrorData as McpError, Peer, RoleServer, ServerHandler, ServiceExt,
};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{unix::OwnedWriteHalf, UnixStream},
    sync::{oneshot, Mutex},
};

use super::{socket_path, tools, Down, Up, INSTRUCTIONS};

pub fn run() -> ! {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
    let code = rt.block_on(async {
        let server = Bridge { link: Arc::new(Link::default()) };
        match server.serve(rmcp::transport::stdio()).await {
            Ok(svc) => {
                let _ = svc.waiting().await;
                0
            }
            Err(e) => {
                eprintln!("excalidesk --mcp: {e}");
                1
            }
        }
    });
    std::process::exit(code)
}

#[derive(Default)]
struct Link {
    conn: Mutex<Option<Arc<Conn>>>,
}

struct Conn {
    writer: Mutex<OwnedWriteHalf>,
    pending: std::sync::Mutex<HashMap<u64, oneshot::Sender<Down>>>,
    next: AtomicU64,
    alive: std::sync::atomic::AtomicBool,
}

impl Conn {
    async fn send(&self, msg: &Up) -> Result<(), String> {
        let mut line = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut w = self.writer.lock().await;
        w.write_all(&line).await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())
    }
}

impl Link {
    /// 拿到和 App 的连接；断了或从没连过就（必要时拉起 App）重新连
    async fn get(&self, peer: &Peer<RoleServer>) -> Result<Arc<Conn>, String> {
        let mut slot = self.conn.lock().await;
        if let Some(c) = slot.as_ref() {
            if c.alive.load(Ordering::SeqCst) {
                return Ok(c.clone());
            }
        }
        let stream = connect_or_launch().await?;
        let (read, write) = stream.into_split();
        let conn = Arc::new(Conn {
            writer: Mutex::new(write),
            pending: Default::default(),
            next: AtomicU64::new(1),
            alive: true.into(),
        });
        let client = peer.peer_info().map(|i| serde_json::to_value(&i.client_info).unwrap_or_default()).unwrap_or(json!({}));
        conn.send(&Up::Hello { client }).await?;
        let reader_conn = conn.clone();
        let peer = peer.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Down>(&line) else { continue };
                match msg {
                    Down::Result { id, .. } => {
                        if let Some(tx) = reader_conn.pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(msg);
                        }
                    }
                    Down::Push { content, meta } => {
                        let n = CustomNotification::new("notifications/claude/channel", Some(json!({ "content": content, "meta": meta })));
                        let _ = peer.send_notification(ServerNotification::CustomNotification(n)).await;
                    }
                }
            }
            // App 退出了：手上的调用全部失败，下一次调用会重新连（App 也会被重新拉起）
            reader_conn.alive.store(false, Ordering::SeqCst);
            reader_conn.pending.lock().unwrap().clear();
        });
        *slot = Some(conn.clone());
        Ok(conn)
    }
}

async fn connect_or_launch() -> Result<UnixStream, String> {
    let path = socket_path();
    if let Ok(s) = UnixStream::connect(&path).await {
        return Ok(s);
    }
    launch_app()?;
    for _ in 0..120 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if let Ok(s) = UnixStream::connect(&path).await {
            return Ok(s);
        }
    }
    Err("Couldn't reach Excalidesk. Open the app (and check Settings → Agents is on), then try again.".into())
}

/// 在 .app 里：`open -g` 拉起（不抢前台）；开发构建：直接起同一个二进制
fn launch_app() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle: Option<PathBuf> = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(PathBuf::from);
    let mut cmd = match bundle {
        Some(b) => {
            let mut c = std::process::Command::new("/usr/bin/open");
            c.arg("-g").arg(b);
            c
        }
        None => std::process::Command::new(exe),
    };
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    cmd.spawn().map(|_| ()).map_err(|e| format!("couldn't start Excalidesk: {e}"))
}

struct Bridge {
    link: Arc<Link>,
}

fn tool_list() -> Vec<Tool> {
    tools()
        .into_iter()
        .map(|t| {
            let schema = match (t.schema)() {
                Value::Object(m) => m,
                _ => Default::default(),
            };
            let mut a = ToolAnnotations::new().read_only(t.read_only);
            a.destructive_hint = Some(false);
            a.open_world_hint = Some(false);
            Tool::new(t.name, t.description, Arc::new(schema)).with_annotations(a)
        })
        .collect()
}

impl ServerHandler for Bridge {
    fn get_info(&self) -> ServerConfig {
        let mut caps = ServerCapabilities::builder().enable_tools().build();
        // Claude Code channels（研究预览）：用户点「发回」而 Agent 没在等时，推一条消息进会话
        caps.experimental = Some([("claude/channel".to_string(), Default::default())].into_iter().collect());
        ServerConfig::new(caps)
            .with_instructions(INSTRUCTIONS)
            .with_server_info(Implementation::new("excalidesk", env!("CARGO_PKG_VERSION")))
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(ProtocolVersion::known_up_to(&ProtocolVersion::V_2025_11_25))
    }

    async fn list_tools(&self, _request: Option<PaginatedRequestParams>, _context: RequestContext<RoleServer>) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(tool_list()))
    }

    async fn call_tool(&self, request: CallToolRequestParams, context: RequestContext<RoleServer>) -> Result<CallToolResponse, McpError> {
        let tool = request.name.to_string();
        if !tools().iter().any(|t| t.name == tool) {
            return Err(McpError::invalid_params(format!("unknown tool {tool}"), None));
        }
        let args = Value::Object(request.arguments.unwrap_or_default());
        let fail = |msg: String| Ok(CallToolResult::error(vec![ContentBlock::text(msg)]).into());
        let conn = match self.link.get(&context.peer).await {
            Ok(c) => c,
            Err(e) => return fail(e),
        };
        let id = conn.next.fetch_add(1, Ordering::SeqCst);
        let (tx, mut rx) = oneshot::channel();
        conn.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = conn.send(&Up::Call { id, tool: tool.clone(), args }).await {
            conn.pending.lock().unwrap().remove(&id);
            return fail(format!("lost the connection to Excalidesk: {e}"));
        }
        let token = context.meta.get_progress_token();
        let mut tick = tokio::time::interval(Duration::from_secs(15));
        tick.tick().await;
        let mut beats = 0u32;
        let reply = loop {
            tokio::select! {
                r = &mut rx => break r,
                _ = context.ct.cancelled() => {
                    conn.pending.lock().unwrap().remove(&id);
                    let _ = conn.send(&Up::Cancel { id }).await;
                    return Err(McpError::internal_error("cancelled", None));
                }
                _ = tick.tick() => {
                    beats += 1;
                    if let Some(t) = &token {
                        let msg = if tool == "wait_for_feedback" { "waiting for the user to press Send in Excalidesk" } else { "working" };
                        let _ = context.peer.notify_progress(ProgressNotificationParam::new(t.clone(), beats as f64).with_message(msg)).await;
                    }
                }
            }
        };
        match reply {
            Ok(Down::Result { content, error, .. }) => {
                let blocks: Vec<ContentBlock> = content.into_iter().filter_map(|c| serde_json::from_value(c).ok()).collect();
                Ok(if error { CallToolResult::error(blocks) } else { CallToolResult::success(blocks) }.into())
            }
            _ => fail("Excalidesk quit before answering. Call the tool again to reopen it.".into()),
        }
    }
}
