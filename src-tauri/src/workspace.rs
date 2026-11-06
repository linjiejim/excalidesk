//! 工作区：持久化状态（文件夹根、最近打开、各文件视口）、文件树扫描、FSEvents 监听。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    time::{Duration, UNIX_EPOCH},
};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Persisted {
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub recent: Vec<String>,
    /// 视口不写进 .excalidraw：只是滚动一下不该改文件、触发 iCloud 上传
    #[serde(default)]
    pub viewports: HashMap<String, Viewport>,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct Viewport {
    #[serde(rename = "scrollX")]
    pub scroll_x: f64,
    #[serde(rename = "scrollY")]
    pub scroll_y: f64,
    pub zoom: f64,
}

pub struct StateFile {
    pub path: PathBuf,
    pub data: Mutex<Persisted>,
}

impl StateFile {
    pub fn load(path: PathBuf) -> Self {
        let data = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self { path, data: Mutex::new(data) }
    }
    pub fn update<R>(&self, f: impl FnOnce(&mut Persisted) -> R) -> R {
        let mut d = self.data.lock().unwrap();
        let r = f(&mut d);
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.path, serde_json::to_vec_pretty(&*d).unwrap_or_default());
        r
    }
    pub fn snapshot(&self) -> Persisted {
        self.data.lock().unwrap().clone()
    }
}

pub fn touch_recent(p: &mut Persisted, path: &str) {
    p.recent.retain(|x| x != path);
    p.recent.insert(0, path.to_string());
    p.recent.truncate(20);
}

#[derive(Serialize)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub dir: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
    pub mtime: u64,
    /// 创建时间（毫秒），侧边栏按创建时间排序用
    pub ctime: u64,
    /// iCloud 里还没下载到本机
    pub dataless: bool,
}

pub const EXT: &str = ".excalidraw";

fn times_ms(p: &Path) -> (u64, u64) {
    let ms = |t: std::io::Result<std::time::SystemTime>| t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    match std::fs::metadata(p) {
        Ok(m) => (ms(m.modified()), ms(m.created())),
        Err(_) => (0, 0),
    }
}

/// 只收 .excalidraw 和包含它们的文件夹；兼容老系统的 `.名字.icloud` 占位文件
pub fn scan(dir: &Path, depth: usize) -> Vec<Node> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out = vec![];
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        let path = ent.path();
        let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if name.starts_with('.') || name == "node_modules" || depth == 0 || name.ends_with(".app") {
                continue;
            }
            let children = scan(&path, depth - 1);
            // 有图的文件夹显示；完全空的文件夹也显示（刚在侧边栏里新建的）
            let empty = std::fs::read_dir(&path)
                .map(|it| it.flatten().all(|e| e.file_name().to_string_lossy().starts_with('.')))
                .unwrap_or(false);
            if !children.is_empty() || empty {
                let (mtime, ctime) = times_ms(&path);
                out.push(Node { name, path: path.display().to_string(), dir: true, children, mtime, ctime, dataless: false });
            }
        } else if let Some(real) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".icloud")).filter(|n| n.ends_with(EXT)) {
            let real_path = path.with_file_name(real);
            let (mtime, ctime) = times_ms(&path);
            out.push(Node { name: real.trim_end_matches(EXT).into(), path: real_path.display().to_string(), dir: false, children: vec![], mtime, ctime, dataless: true });
        } else if name.ends_with(EXT) && !name.starts_with('.') {
            let (mtime, ctime) = times_ms(&path);
            out.push(Node {
                name: name.trim_end_matches(EXT).into(),
                dataless: crate::icloud::is_dataless(&path),
                mtime,
                ctime,
                path: path.display().to_string(),
                dir: false,
                children: vec![],
            });
        }
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

/// 文件夹下所有 .excalidraw（重命名文件夹时搬历史版本用）
pub fn all_docs(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    for n in scan(dir, 12) {
        collect(&n, &mut out);
    }
    out
}

fn collect(n: &Node, out: &mut Vec<PathBuf>) {
    if n.dir {
        n.children.iter().for_each(|c| collect(c, out));
    } else {
        out.push(PathBuf::from(&n.path));
    }
}

/// 在 dir 下找一个不重名的「未命名 N.excalidraw」
pub fn unique_name(dir: &Path, base: &str) -> PathBuf {
    unique_with_ext(dir, base, EXT)
}

/// ext 为空时用于文件夹
pub fn unique_with_ext(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{base}{ext}"));
    if !first.exists() {
        return first;
    }
    (2..).map(|i| dir.join(format!("{base} {i}{ext}"))).find(|p| !p.exists()).unwrap()
}

/// 重命名后同步更新视口和最近打开里的路径（文件或文件夹）
pub fn rename_paths(p: &mut Persisted, from: &str, to: &str) {
    let map = |s: &str| -> Option<String> {
        if s == from {
            Some(to.to_string())
        } else {
            s.strip_prefix(&format!("{from}/")).map(|rest| format!("{to}/{rest}"))
        }
    };
    for r in p.recent.iter_mut().chain(p.roots.iter_mut()) {
        if let Some(n) = map(r) {
            *r = n;
        }
    }
    let vps: Vec<(String, Viewport)> = p.viewports.drain().map(|(k, v)| (map(&k).unwrap_or(k), v)).collect();
    p.viewports.extend(vps);
}

/// FSEvents 监听：300ms 内的变化合并成一次 `fs-changed` 事件
pub struct Watch(pub Mutex<Option<notify::RecommendedWatcher>>);

pub fn rewatch(app: &AppHandle, watch: &Watch, paths: &[(PathBuf, bool)]) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                let _ = tx.send(p);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    for (p, recursive) in paths {
        let mode = if *recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
        let _ = w.watch(p, mode);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            while let Ok(p) = rx.recv_timeout(Duration::from_millis(300)) {
                batch.push(p);
            }
            // 自己保存引起的事件（磁盘状态和最后一次写入一致）不再通知前端，省得每次保存都重扫目录树
            let store = app.state::<crate::doc::DocStore>();
            let mut names: Vec<String> = batch
                .into_iter()
                .filter(|p| !crate::doc::is_own_write(&store, p))
                .map(|p| p.display().to_string())
                .filter(|s| !s.ends_with(".tmp~"))
                .collect();
            names.sort();
            names.dedup();
            if !names.is_empty() {
                let _ = app.emit("fs-changed", names);
            }
        }
    });
    // 旧 watcher 被替换时 drop，对应线程的 rx 随之结束
    *watch.0.lock().unwrap() = Some(w);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_updates_recent_and_viewports() {
        let mut p = Persisted::default();
        p.recent = vec!["/a/x.excalidraw".into(), "/a/sub/y.excalidraw".into(), "/b/z.excalidraw".into()];
        p.viewports.insert("/a/sub/y.excalidraw".into(), Viewport { scroll_x: 1.0, scroll_y: 2.0, zoom: 1.0 });
        rename_paths(&mut p, "/a/sub", "/a/sub2");
        assert_eq!(p.recent[1], "/a/sub2/y.excalidraw");
        assert!(p.viewports.contains_key("/a/sub2/y.excalidraw"));
        rename_paths(&mut p, "/a/x.excalidraw", "/a/w.excalidraw");
        assert_eq!(p.recent[0], "/a/w.excalidraw");
        assert_eq!(p.recent[2], "/b/z.excalidraw");
    }

    #[test]
    fn scan_filters_and_sorts() {
        let d = std::env::temp_dir().join(format!("excalidesk-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("b-dir/deep")).unwrap();
        std::fs::create_dir_all(d.join("empty-dir")).unwrap();
        std::fs::create_dir_all(d.join(".hidden")).unwrap();
        for f in ["Zeta.excalidraw", "alpha.excalidraw", "notes.txt", "b-dir/deep/x.excalidraw", ".hidden/h.excalidraw", ".gone.excalidraw.icloud"] {
            std::fs::write(d.join(f), "{}").unwrap();
        }
        let t = scan(&d, 6);
        let names: Vec<_> = t.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["b-dir", "empty-dir", "alpha", "gone", "Zeta"]);
        assert!(t.iter().find(|n| n.name == "gone").unwrap().dataless);
        assert_eq!(t[0].children[0].children[0].name, "x");
        assert_eq!(unique_name(&d, "alpha"), d.join("alpha 2.excalidraw"));
        // 空文件夹显示，没有图的非空文件夹不显示
        assert!(t.iter().any(|n| n.name == "empty-dir"));
        std::fs::write(d.join("empty-dir/readme.txt"), "x").unwrap();
        assert!(!scan(&d, 6).iter().any(|n| n.name == "empty-dir"));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
