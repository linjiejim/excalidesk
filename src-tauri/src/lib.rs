use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Instant,
};

use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

mod doc;
mod fps;
mod history;
mod icloud;
mod menu;
mod workspace;

use doc::{Delta, Doc, DocStore, SaveResult};
use workspace::{Node, Persisted, StateFile, Viewport, Watch};

static FPS_UNLOCKED: AtomicBool = AtomicBool::new(false);
/// 前端确认所有文档都保存完之后才允许关窗 / 退出
static ALLOW_EXIT: AtomicBool = AtomicBool::new(false);

/// 启动参数：--fps=60|120 --env=<标签> --results=<目录> --state=<状态文件> --bench --selftest --autoquit
#[derive(Clone)]
struct Opts {
    fps: u32,
    env: String,
    results: PathBuf,
    state: Option<PathBuf>,
    bench: bool,
    selftest: bool,
    autoquit: bool,
    icloud_probe: bool,
    /// 基准模式下也用正式窗口样式，用来测它对渲染的影响
    vibrant: bool,
}

fn parse_opts() -> Opts {
    let mut o = Opts {
        fps: 120,
        env: String::new(),
        results: std::env::temp_dir().join("p0-results"),
        state: None,
        bench: false,
        selftest: false,
        autoquit: false,
        icloud_probe: false,
        vibrant: false,
    };
    for a in std::env::args().skip(1) {
        if let Some(v) = a.strip_prefix("--fps=") {
            o.fps = v.parse().unwrap_or(120);
        } else if let Some(v) = a.strip_prefix("--env=") {
            o.env = v.to_string();
        } else if let Some(v) = a.strip_prefix("--results=") {
            o.results = PathBuf::from(v);
        } else if let Some(v) = a.strip_prefix("--state=") {
            o.state = Some(PathBuf::from(v));
        } else if a == "--bench" {
            o.bench = true;
        } else if a == "--selftest" {
            o.selftest = true;
        } else if a == "--autoquit" {
            o.autoquit = true;
        } else if a == "--vibrant" {
            o.vibrant = true;
        } else if a == "--icloud-probe" {
            o.icloud_probe = true;
        }
    }
    if o.env.is_empty() {
        o.env = format!("tauri-{}", o.fps);
    }
    o
}

#[derive(Default)]
struct PendingOpens(Mutex<Vec<String>>);

/// 历史快照根目录：和状态文件放在一起
struct HistoryRoot(PathBuf);

/// header 只能放 ASCII，前端用 encodeURIComponent 传路径
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn path_header(request: &Request<'_>) -> Result<PathBuf, String> {
    request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .map(|s| PathBuf::from(percent_decode(s)))
        .ok_or_else(|| "缺少 path".into())
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err("需要二进制请求体".into()),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ── 工作区 ─────────────────────────────────────────────

#[tauri::command]
fn state_get(app: AppHandle) -> Persisted {
    app.state::<StateFile>().snapshot()
}

#[tauri::command]
async fn workspace_pick(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().set_title("选择一个放图的文件夹").blocking_pick_folder();
    let Some(p) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let s = p.display().to_string();
    app.state::<StateFile>().update(|d| {
        if !d.roots.contains(&s) {
            d.roots.push(s.clone());
        }
    });
    Ok(Some(s))
}

#[tauri::command]
fn workspace_add(app: AppHandle, path: String) {
    app.state::<StateFile>().update(|d| {
        if !d.roots.contains(&path) {
            d.roots.push(path);
        }
    });
}

#[tauri::command]
fn workspace_remove(app: AppHandle, path: String) {
    app.state::<StateFile>().update(|d| d.roots.retain(|r| r != &path));
}

#[tauri::command]
async fn tree(root: String) -> Result<Vec<Node>, String> {
    blocking(move || Ok(workspace::scan(&PathBuf::from(root), 6))).await
}

/// paths: [路径, 是否递归]
#[tauri::command]
fn watch_set(app: AppHandle, paths: Vec<(String, bool)>) -> Result<(), String> {
    let list: Vec<(PathBuf, bool)> = paths.into_iter().map(|(p, r)| (PathBuf::from(p), r)).collect();
    workspace::rewatch(&app, &app.state::<Watch>(), &list)
}

#[tauri::command]
fn viewport_set(app: AppHandle, path: String, viewport: Viewport) {
    app.state::<StateFile>().update(|d| {
        d.viewports.insert(path, viewport);
    });
}

#[tauri::command]
fn sync_status(path: String) -> icloud::SyncStatus {
    #[cfg(target_os = "macos")]
    return icloud::sync_status(&PathBuf::from(path));
    #[cfg(not(target_os = "macos"))]
    icloud::SyncStatus::default()
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    std::process::Command::new("open").arg("-R").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// iCloud Drive 里的默认工作区：~/Library/Mobile Documents/com~apple~CloudDocs/Excalidraw
#[tauri::command]
fn icloud_default_dir(app: AppHandle) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let drive = PathBuf::from(home).join("Library/Mobile Documents/com~apple~CloudDocs");
    if !drive.exists() {
        return Err("这台 Mac 没有开启 iCloud Drive".into());
    }
    let d = drive.join("Excalidraw");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let s = d.display().to_string();
    app.state::<StateFile>().update(|st| {
        if !st.roots.contains(&s) {
            st.roots.push(s.clone());
        }
    });
    Ok(s)
}

/// 统一成真实路径：FSEvents 报告的是解析过符号链接的路径（如 /var → /private/var）
#[tauri::command]
fn real_path(path: String) -> String {
    fs::canonicalize(&path).map(|p| p.display().to_string()).unwrap_or(path)
}

#[tauri::command]
fn take_pending_opens(app: AppHandle) -> Vec<String> {
    std::mem::take(&mut *app.state::<PendingOpens>().0.lock().unwrap())
}

// ── 文档 ───────────────────────────────────────────────

/// 返回文件原始字节（前端自己解析），同时在 Rust 侧建好内存模型
#[tauri::command]
async fn doc_open(app: AppHandle, path: String) -> Result<Response, String> {
    let p = PathBuf::from(&path);
    let a = app.clone();
    let bytes = blocking(move || {
        let bytes = doc::read_file(&p)?;
        let mut d = Doc::parse(&bytes)?;
        d.disk = doc::disk_meta(&p);
        a.state::<DocStore>().0.lock().unwrap().insert(p, d);
        Ok(bytes)
    })
    .await?;
    app.state::<StateFile>().update(|d| workspace::touch_recent(d, &path));
    Ok(Response::new(bytes))
}

/// 外部修改 / 被删除或移走：磁盘上的 (mtime, len) 和我们最后一次读写时比
#[tauri::command]
fn doc_disk_status(app: AppHandle, path: String) -> doc::DiskStatus {
    doc::disk_status(&app.state::<DocStore>(), &PathBuf::from(path))
}

#[tauri::command]
fn doc_close(app: AppHandle, path: String) {
    app.state::<DocStore>().0.lock().unwrap().remove(&PathBuf::from(path));
}

/// 请求体：{"upserts":[...变了的元素], "appState":{...}|null, "files":[...新图片]}
#[tauri::command]
async fn doc_save(app: AppHandle, request: Request<'_>) -> Result<SaveResult, String> {
    let path = path_header(&request)?;
    let body = raw_body(&request)?;
    blocking(move || {
        let delta: Delta = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        doc::save(&app.state::<DocStore>(), &path, delta, &app.state::<HistoryRoot>().0)
    })
    .await
}

#[tauri::command]
fn doc_create(dir: String, base: Option<String>) -> Result<String, String> {
    let p = workspace::unique_name(&PathBuf::from(dir), base.as_deref().unwrap_or("未命名"));
    doc::write_file(&p, &Doc::default().serialize())?;
    Ok(p.display().to_string())
}

// ── 历史版本 / iCloud 冲突 ─────────────────────────────

#[tauri::command]
fn history_list(app: AppHandle, path: String) -> Vec<history::Entry> {
    history::list(&app.state::<HistoryRoot>().0, &PathBuf::from(path))
}

#[tauri::command]
async fn history_read(app: AppHandle, path: String, id: String) -> Result<Response, String> {
    let root = app.state::<HistoryRoot>().0.clone();
    blocking(move || history::read(&root, &PathBuf::from(path), &id)).await.map(Response::new)
}

/// 合并外部修改 / 冲突版本、恢复历史之前，先给当前内容留一份
#[tauri::command]
fn history_snapshot(app: AppHandle, path: String, reason: String) -> Result<Option<history::Entry>, String> {
    let p = PathBuf::from(path);
    let root = app.state::<HistoryRoot>().0.clone();
    let store = app.state::<DocStore>();
    let mut map = store.0.lock().unwrap();
    Ok(map.get_mut(&p).and_then(|d| d.snapshot(&root, &p, &reason).ok()))
}

#[tauri::command]
fn conflicts_list(path: String) -> Vec<icloud::ConflictVersion> {
    #[cfg(target_os = "macos")]
    return icloud::conflict_versions(&PathBuf::from(path));
    #[cfg(not(target_os = "macos"))]
    vec![]
}

/// 冲突版本的内容（在系统版本库里，只读）
#[tauri::command]
async fn conflict_read(version_path: String) -> Result<Response, String> {
    blocking(move || fs::read(&version_path).map_err(|e| e.to_string())).await.map(Response::new)
}

#[tauri::command]
fn conflicts_resolve(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return icloud::resolve_conflicts(&PathBuf::from(path));
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

// ── 文件操作（侧边栏右键菜单）──────────────────────────

fn check_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.contains('/') || n.starts_with('.') || n.contains(':') {
        return Err("名字不能为空，也不能包含 / 或 :，不能以 . 开头".into());
    }
    Ok(n.to_string())
}

/// 重命名文件或文件夹；打开中的文档、视口、最近打开、历史版本都跟着改
#[tauri::command]
async fn path_rename(app: AppHandle, from: String, name: String) -> Result<String, String> {
    let src = PathBuf::from(&from);
    let mut n = check_name(&name)?;
    let is_file = src.is_file();
    if is_file && !n.ends_with(workspace::EXT) {
        n.push_str(workspace::EXT);
    }
    let dst = src.parent().ok_or("没有上级目录")?.join(&n);
    if dst == src {
        return Ok(from);
    }
    if dst.exists() {
        return Err(format!("「{n}」已经存在"));
    }
    let to = dst.display().to_string();
    let a = app.clone();
    let (from2, to2) = (from.clone(), to.clone());
    blocking(move || {
        fs::rename(&src, &dst).map_err(|e| e.to_string())?;
        let root = a.state::<HistoryRoot>().0.clone();
        // 打开中的文档换 key
        {
            let store = a.state::<DocStore>();
            let mut map = store.0.lock().unwrap();
            let keys: Vec<PathBuf> = map.keys().filter(|k| *k == &src || k.starts_with(&src)).cloned().collect();
            for k in keys {
                let nk = dst.join(k.strip_prefix(&src).unwrap_or(Path::new("")));
                let nk = if k == src { dst.clone() } else { nk };
                if let Some(mut d) = map.remove(&k) {
                    d.disk = doc::disk_meta(&nk);
                    map.insert(nk, d);
                }
            }
        }
        // 历史版本按路径哈希存，逐个搬
        if is_file {
            history::rename(&root, &src, &dst);
        } else {
            for f in workspace::all_docs(&dst) {
                let old = src.join(f.strip_prefix(&dst).unwrap());
                history::rename(&root, &old, &f);
            }
        }
        a.state::<StateFile>().update(|st| workspace::rename_paths(st, &from2, &to2));
        Ok(())
    })
    .await?;
    Ok(to)
}

#[tauri::command]
async fn path_duplicate(path: String) -> Result<String, String> {
    blocking(move || {
        let src = PathBuf::from(&path);
        let stem = src.file_name().map(|n| n.to_string_lossy().trim_end_matches(workspace::EXT).to_string()).unwrap_or_default();
        let dst = workspace::unique_name(src.parent().ok_or("没有上级目录")?, &format!("{stem} 副本"));
        let bytes = doc::read_file(&src)?;
        doc::write_file(&dst, &bytes)?;
        Ok(dst.display().to_string())
    })
    .await
}

#[tauri::command]
async fn path_trash(app: AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    app.state::<DocStore>().0.lock().unwrap().retain(|k, _| k != &p && !k.starts_with(&p));
    blocking(move || {
        #[cfg(target_os = "macos")]
        return icloud::trash(&p);
        #[cfg(not(target_os = "macos"))]
        Err::<String, String>("只支持 macOS".into())
    })
    .await
}

#[tauri::command]
fn dir_create(parent: String, name: Option<String>) -> Result<String, String> {
    let base = check_name(name.as_deref().unwrap_or("新建文件夹"))?;
    let d = workspace::unique_with_ext(&PathBuf::from(parent), &base, "");
    fs::create_dir(&d).map_err(|e| e.to_string())?;
    Ok(d.display().to_string())
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut child = std::process::Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    child.stdin.take().unwrap().write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    child.wait().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn confirm(app: AppHandle, title: String, message: String, ok: String) -> bool {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok, "取消".into()))
        .blocking_show()
}

#[tauri::command]
async fn pick_open_file(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Excalidraw", &["excalidraw"])
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

#[tauri::command]
async fn pick_save_path(app: AppHandle, name: String, ext: String) -> Option<String> {
    app.dialog()
        .file()
        .set_file_name(format!("{name}.{ext}"))
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

#[tauri::command]
async fn write_bytes(request: Request<'_>) -> Result<(), String> {
    let path = path_header(&request)?;
    let body = raw_body(&request)?;
    blocking(move || doc::write_file(&path, &body)).await
}

#[tauri::command]
fn close_now(app: AppHandle) {
    ALLOW_EXIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

// ── P0 基准 / 自测辅助 ─────────────────────────────────

#[tauri::command]
fn bench_result(app: AppHandle, json: String) -> Result<String, String> {
    let o = app.state::<Opts>();
    fs::create_dir_all(&o.results).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let path = o.results.join(format!("{}-{}.json", o.env, ts));
    fs::write(&path, json).map_err(|e| e.to_string())?;
    if o.autoquit {
        ALLOW_EXIT.store(true, Ordering::SeqCst);
        app.exit(0);
    }
    Ok(path.display().to_string())
}

/// P0 保存基准：原始字节直写
#[tauri::command]
fn save_doc(request: Request<'_>) -> Result<u64, String> {
    let t = Instant::now();
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw body".into()) };
    let path = path_header(&request).unwrap_or_else(|_| std::env::temp_dir().join("p0-save-test.excalidraw"));
    let tmp = path.with_extension("excalidraw.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(t.elapsed().as_micros() as u64)
}

#[tauri::command]
fn opts(app: AppHandle) -> serde_json::Value {
    let o = app.state::<Opts>();
    serde_json::json!({
        "fps": o.fps, "env": o.env, "bench": o.bench, "selftest": o.selftest,
        "fpsUnlocked": FPS_UNLOCKED.load(Ordering::SeqCst),
    })
}

#[tauri::command]
fn selftest_dir() -> Result<String, String> {
    let d = std::env::temp_dir().join(format!("excalidesk-selftest-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join("子文件夹")).map_err(|e| e.to_string())?;
    Ok(d.display().to_string())
}

#[tauri::command]
fn debug_size(path: String) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

#[tauri::command]
fn debug_read(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// 自测：模拟文件在外部被删掉（只允许临时目录）
#[tauri::command]
fn debug_remove(path: String) -> Result<(), String> {
    let p = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let tmp = fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
    if !p.starts_with(&tmp) {
        return Err("只能删临时目录里的文件".into());
    }
    fs::remove_file(p).map_err(|e| e.to_string())
}

/// 模拟另一台设备改了文件：直接改磁盘，不经过 DocStore
#[tauri::command]
async fn external_edit(path: String, element: serde_json::Value) -> Result<(), String> {
    blocking(move || {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        v["elements"].as_array_mut().ok_or("no elements")?.push(element);
        std::thread::sleep(std::time::Duration::from_millis(1100)); // 保证 mtime 变化
        fs::write(&path, serde_json::to_vec_pretty(&v).unwrap()).map_err(|e| e.to_string())
    })
    .await
}

// ── 启动 ───────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let o = parse_opts();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(o.clone())
        .manage(DocStore::default())
        .manage(Watch(Mutex::new(None)))
        .manage(PendingOpens::default())
        .invoke_handler(tauri::generate_handler![
            state_get, workspace_pick, workspace_add, workspace_remove, tree, watch_set, viewport_set,
            sync_status, reveal, take_pending_opens, icloud_default_dir, real_path,
            doc_open, doc_disk_status, doc_close, doc_save, doc_create,
            history_list, history_read, history_snapshot, conflicts_list, conflict_read, conflicts_resolve,
            path_rename, path_duplicate, path_trash, dir_create, copy_text, confirm, debug_remove,
            pick_open_file, pick_save_path, write_bytes, close_now,
            bench_result, save_doc, opts, icloud::icloud_probe, selftest_dir, debug_read, debug_size, external_edit,
        ])
        .setup(move |app| {
            let state_path = o.state.clone().unwrap_or_else(|| {
                app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir()).join("state.json")
            });
            app.manage(HistoryRoot(state_path.parent().map(|p| p.join("history")).unwrap_or_else(|| std::env::temp_dir().join("excalidesk-history"))));
            app.manage(StateFile::load(state_path));
            app.set_menu(menu::build(app.handle())?)?;
            app.on_menu_event(|app, ev| {
                let _ = app.emit("menu", ev.id().0.clone());
            });

            let query = if o.bench {
                format!("index.html?bench=1&env={}", o.env)
            } else if o.selftest {
                "index.html?selftest=1".to_string()
            } else {
                "index.html".to_string()
            };
            let title = if o.bench { format!("Excalidesk · {}", o.env) } else { "Excalidesk".into() };
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(query.into()))
                .title(title)
                .inner_size(1360.0, 900.0)
                .min_inner_size(720.0, 480.0)
                .disable_drag_drop_handler();
            // 标题栏透明、红绿灯叠在内容上，标题栏和标签栏合成一条。
            // 不用窗口透明 + 毛玻璃：实测透明 WKWebView 每帧要带 alpha 合成，30% 缩放平移从 47fps 掉到 24fps。
            #[cfg(target_os = "macos")]
            if !o.bench || o.vibrant {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(16.0, 20.0));
            }
            let win = builder.build()?;
            let handle = app.handle().clone();
            win.on_window_event(move |ev| {
                if let WindowEvent::CloseRequested { api, .. } = ev {
                    if !ALLOW_EXIT.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = handle.emit("app-close-requested", ());
                    }
                }
            });
            if o.icloud_probe {
                let handle = app.handle().clone();
                let dir = o.results.clone();
                std::thread::spawn(move || {
                    let report = icloud::probe();
                    let _ = fs::create_dir_all(&dir);
                    let _ = fs::write(dir.join("icloud-probe.json"), serde_json::to_string_pretty(&report).unwrap());
                    ALLOW_EXIT.store(true, Ordering::SeqCst);
                    handle.exit(0);
                });
            }
            if o.fps > 60 {
                win.with_webview(|wv| {
                    let ok = unsafe { fps::set_60fps_cap(wv.inner(), false) };
                    FPS_UNLOCKED.store(ok, Ordering::SeqCst);
                })?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        // Finder 双击 / 拖到 Dock 图标：冷启动也走这里，先存起来，前端加载好后来取
        RunEvent::Opened { urls } => {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.display().to_string())
                .collect();
            app.state::<PendingOpens>().0.lock().unwrap().extend(paths.clone());
            let _ = app.emit("open-paths", paths);
        }
        RunEvent::ExitRequested { api, .. } => {
            if !ALLOW_EXIT.load(Ordering::SeqCst) {
                api.prevent_exit();
                let _ = app.emit("app-close-requested", ());
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn percent_decode_utf8() {
        assert_eq!(super::percent_decode("%2Ftmp%2F%E5%AD%90%20a.excalidraw"), "/tmp/子 a.excalidraw");
        assert_eq!(super::percent_decode("plain%"), "plain%");
    }
}
