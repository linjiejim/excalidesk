//! 工作区：持久化状态（文件夹根、最近打开、各文件视口）、文件树扫描、FSEvents 监听。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    time::{Duration, UNIX_EPOCH},
};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

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
    /// iCloud 里还没下载到本机
    pub dataless: bool,
}

pub const EXT: &str = ".excalidraw";

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
            if !children.is_empty() {
                out.push(Node { name, path: path.display().to_string(), dir: true, children, mtime: 0, dataless: false });
            }
        } else if let Some(real) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".icloud")).filter(|n| n.ends_with(EXT)) {
            let real_path = path.with_file_name(real);
            out.push(Node { name: real.trim_end_matches(EXT).into(), path: real_path.display().to_string(), dir: false, children: vec![], mtime: 0, dataless: true });
        } else if name.ends_with(EXT) && !name.starts_with('.') {
            out.push(Node {
                name: name.trim_end_matches(EXT).into(),
                dataless: crate::icloud::is_dataless(&path),
                mtime: mtime_ms(&path),
                path: path.display().to_string(),
                dir: false,
                children: vec![],
            });
        }
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

/// 在 dir 下找一个不重名的「未命名 N.excalidraw」
pub fn unique_name(dir: &Path, base: &str) -> PathBuf {
    let first = dir.join(format!("{base}{EXT}"));
    if !first.exists() {
        return first;
    }
    (2..).map(|i| dir.join(format!("{base} {i}{EXT}"))).find(|p| !p.exists()).unwrap()
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
            let mut names: Vec<String> = batch
                .into_iter()
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
        assert_eq!(names, ["b-dir", "alpha", "gone", "Zeta"]);
        assert!(t.iter().find(|n| n.name == "gone").unwrap().dataless);
        assert_eq!(t[0].children[0].children[0].name, "x");
        assert_eq!(unique_name(&d, "alpha"), d.join("alpha 2.excalidraw"));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
