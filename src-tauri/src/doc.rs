//! 打开文档的内存模型 + 增量保存。
//! 前端每次只发「变了的元素」和「新出现的图片」，Rust 维护整张图，按 fractional index 排序后写回标准 .excalidraw。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Instant, SystemTime},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Default)]
pub struct Doc {
    elements: HashMap<String, Value>,
    app_state: Value,
    files: Map<String, Value>,
    /// 最近一次由我们写入（或读入）时磁盘上的 (mtime, len)，用来区分外部修改和自己写的回声
    pub disk: Option<(SystemTime, u64)>,
}

#[derive(Default)]
pub struct DocStore(pub Mutex<HashMap<PathBuf, Doc>>);

#[derive(Deserialize)]
pub struct Delta {
    #[serde(default)]
    pub upserts: Vec<Value>,
    #[serde(rename = "appState")]
    pub app_state: Option<Value>,
    #[serde(default)]
    pub files: Vec<Value>,
}

#[derive(Serialize)]
pub struct SaveResult {
    pub bytes: usize,
    pub elements: usize,
    pub ms: f64,
}

pub fn disk_meta(p: &Path) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(p).ok()?;
    Some((m.modified().ok()?, m.len()))
}

impl Doc {
    pub fn parse(bytes: &[u8]) -> Result<Doc, String> {
        if bytes.iter().all(|b| b.is_ascii_whitespace()) {
            return Ok(Doc::default());
        }
        let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("不是有效的 .excalidraw 文件：{e}"))?;
        let mut d = Doc::default();
        if let Some(els) = v.get("elements").and_then(Value::as_array) {
            for e in els {
                if let Some(id) = e.get("id").and_then(Value::as_str) {
                    d.elements.insert(id.to_string(), e.clone());
                }
            }
        }
        d.app_state = v.get("appState").cloned().unwrap_or_else(|| json!({}));
        if let Some(f) = v.get("files").and_then(Value::as_object) {
            d.files = f.clone();
        }
        Ok(d)
    }

    pub fn apply(&mut self, delta: Delta) {
        for e in delta.upserts {
            if let Some(id) = e.get("id").and_then(Value::as_str) {
                self.elements.insert(id.to_string(), e);
            }
        }
        if let Some(s) = delta.app_state {
            self.app_state = s;
        }
        for f in delta.files {
            if let Some(id) = f.get("id").and_then(Value::as_str) {
                self.files.insert(id.to_string(), f);
            }
        }
    }

    /// 元素按 fractional index（base62 字符串，ASCII 序即大小序）排序；没有 index 的排在最后，再按 id 稳定排序。
    /// 只保留仍被未删除图片元素引用的图片（和官方 serializeAsJSON 一致）。
    pub fn serialize(&self) -> Vec<u8> {
        let mut els: Vec<&Value> = self.elements.values().collect();
        els.sort_by(|a, b| {
            let ia = a.get("index").and_then(Value::as_str);
            let ib = b.get("index").and_then(Value::as_str);
            match (ia, ib) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
            .then_with(|| a.get("id").and_then(Value::as_str).cmp(&b.get("id").and_then(Value::as_str)))
        });
        let mut files = Map::new();
        for e in &els {
            let deleted = e.get("isDeleted").and_then(Value::as_bool).unwrap_or(false);
            if let (false, Some(fid)) = (deleted, e.get("fileId").and_then(Value::as_str)) {
                if let Some(f) = self.files.get(fid) {
                    files.insert(fid.to_string(), f.clone());
                }
            }
        }
        let doc = json!({
            "type": "excalidraw",
            "version": 2,
            "source": "https://github.com/excalidraw/excalidraw (Excalidesk)",
            "elements": els,
            "appState": self.app_state,
            "files": files,
        });
        serde_json::to_vec_pretty(&doc).unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.elements.len()
    }
}

/// 读：iCloud 里还没下载的文件，协调读会阻塞到下载完成，所以调用方必须在后台线程
pub fn read_file(p: &Path) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    return crate::icloud::coordinated_read(p);
    #[cfg(not(target_os = "macos"))]
    std::fs::read(p).map_err(|e| e.to_string())
}

/// 写：协调写 + 临时文件 rename（原子）
pub fn write_file(p: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return crate::icloud::coordinated_write(p, bytes);
    #[cfg(not(target_os = "macos"))]
    {
        let tmp = p.with_extension("tmp~");
        std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, p)).map_err(|e| e.to_string())
    }
}

pub fn save(store: &DocStore, path: &Path, delta: Delta) -> Result<SaveResult, String> {
    let t = Instant::now();
    let mut map = store.0.lock().unwrap();
    let doc = map.get_mut(path).ok_or("文档没有打开")?;
    doc.apply(delta);
    let bytes = doc.serialize();
    write_file(path, &bytes)?;
    doc.disk = disk_meta(path);
    Ok(SaveResult { bytes: bytes.len(), elements: doc.len(), ms: t.elapsed().as_secs_f64() * 1e3 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(id: &str, index: &str, version: u64) -> Value {
        json!({ "id": id, "type": "rectangle", "index": index, "version": version, "isDeleted": false })
    }

    #[test]
    fn upsert_and_order_by_fractional_index() {
        let mut d = Doc::parse(br#"{"elements":[{"id":"b","index":"a1","version":1},{"id":"a","index":"a0","version":1}],"appState":{"gridSize":20},"files":{}}"#).unwrap();
        d.apply(Delta { upserts: vec![el("c", "a0V", 1), el("b", "a1", 2)], app_state: None, files: vec![] });
        let out: Value = serde_json::from_slice(&d.serialize()).unwrap();
        let ids: Vec<&str> = out["elements"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["a", "c", "b"]);
        assert_eq!(out["elements"][2]["version"], 2);
        assert_eq!(out["appState"]["gridSize"], 20);
        assert_eq!(out["type"], "excalidraw");
    }

    #[test]
    fn files_only_kept_for_live_images() {
        let mut d = Doc::default();
        d.apply(Delta {
            upserts: vec![
                json!({"id":"i1","type":"image","fileId":"f1","index":"a0","isDeleted":false}),
                json!({"id":"i2","type":"image","fileId":"f2","index":"a1","isDeleted":true}),
            ],
            app_state: Some(json!({})),
            files: vec![json!({"id":"f1","dataURL":"data:x"}), json!({"id":"f2","dataURL":"data:y"})],
        });
        let out: Value = serde_json::from_slice(&d.serialize()).unwrap();
        assert!(out["files"].get("f1").is_some());
        assert!(out["files"].get("f2").is_none());
        // 删除标记（墓碑）保留在文件里，供多设备合并
        assert_eq!(out["elements"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn empty_file_is_empty_scene() {
        let d = Doc::parse(b"  ").unwrap();
        assert_eq!(d.len(), 0);
        assert!(Doc::parse(b"{not json").is_err());
    }
}
