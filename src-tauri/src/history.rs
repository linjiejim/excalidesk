//! 本地历史版本：iCloud 吞了数据、合并结果不满意时的兜底。
//!
//! 目录：<数据目录>/history/<路径哈希>/
//!   <毫秒时间戳>-<原因>-<元素数>.json.gz   正文快照（elements + appState + 引用的图片 id），不含图片本体
//!   files/<fileId>.json.gz                 图片按 id 只存一次（Excalidraw 的图片按 id 不可变）
//! 保留最近 50 个；超过 30 天的删掉，但每个文件至少留 5 个。

use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const KEEP: usize = 50;
const KEEP_MIN: usize = 5;
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);

#[derive(Serialize, Debug, Clone)]
pub struct Entry {
    pub id: String,
    pub ts: u64,
    pub reason: String,
    pub elements: usize,
    pub bytes: u64,
}

pub fn dir_for(root: &Path, doc: &Path) -> PathBuf {
    let h = Sha256::digest(doc.display().to_string().as_bytes());
    root.join(h.iter().take(8).map(|b| format!("{b:02x}")).collect::<String>())
}

fn gz(bytes: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::fast());
    let _ = e.write_all(bytes);
    e.finish().unwrap_or_default()
}

fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    GzDecoder::new(bytes).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

/// elements 里只算未删除的，用于列表展示
pub fn snapshot(root: &Path, doc: &Path, elements: &[&Value], app_state: &Value, files: &Map<String, Value>, reason: &str) -> Result<Entry, String> {
    let dir = dir_for(root, doc);
    fs::create_dir_all(dir.join("files")).map_err(|e| e.to_string())?;
    let mut file_ids = vec![];
    for e in elements {
        if let Some(fid) = e.get("fileId").and_then(Value::as_str) {
            if let Some(f) = files.get(fid) {
                let fp = dir.join("files").join(format!("{}.json.gz", sanitize(fid)));
                if !fp.exists() {
                    fs::write(&fp, gz(&serde_json::to_vec(f).unwrap_or_default())).map_err(|e| e.to_string())?;
                }
                file_ids.push(fid.to_string());
            }
        }
    }
    let live = elements.iter().filter(|e| !e.get("isDeleted").and_then(Value::as_bool).unwrap_or(false)).count();
    let body = json!({ "path": doc.display().to_string(), "elements": elements, "appState": app_state, "fileIds": file_ids });
    let ts = now_ms();
    let reason = sanitize(reason);
    let id = format!("{ts}-{reason}-{live}");
    let data = gz(&serde_json::to_vec(&body).unwrap_or_default());
    fs::write(dir.join(format!("{id}.json.gz")), &data).map_err(|e| e.to_string())?;
    prune(&dir);
    Ok(Entry { id, ts, reason, elements: live, bytes: data.len() as u64 })
}

fn sanitize(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect()
}

pub fn list(root: &Path, doc: &Path) -> Vec<Entry> {
    let dir = dir_for(root, doc);
    let Ok(rd) = fs::read_dir(&dir) else { return vec![] };
    let mut out: Vec<Entry> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".json.gz")?.to_string();
            let mut it = id.splitn(3, '-');
            let ts = it.next()?.parse().ok()?;
            let reason = it.next()?.to_string();
            let elements = it.next()?.parse().ok()?;
            Some(Entry { bytes: e.metadata().map(|m| m.len()).unwrap_or(0), id, ts, reason, elements })
        })
        .collect();
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

/// 还原成完整的 .excalidraw（带图片）
pub fn read(root: &Path, doc: &Path, id: &str) -> Result<Vec<u8>, String> {
    let dir = dir_for(root, doc);
    let raw = fs::read(dir.join(format!("{}.json.gz", id.replace(['/', '.'], "")))).map_err(|e| e.to_string())?;
    let body: Value = serde_json::from_slice(&gunzip(&raw)?).map_err(|e| e.to_string())?;
    let mut files = Map::new();
    for fid in body["fileIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if let Ok(b) = fs::read(dir.join("files").join(format!("{}.json.gz", sanitize(fid)))) {
            if let Ok(v) = serde_json::from_slice::<Value>(&gunzip(&b)?) {
                files.insert(fid.to_string(), v);
            }
        }
    }
    let out = json!({ "type": "excalidraw", "version": 2, "source": "Excalidesk history", "elements": body["elements"], "appState": body["appState"], "files": files });
    serde_json::to_vec(&out).map_err(|e| e.to_string())
}

fn prune(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut snaps: Vec<(u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            let ts = n.split('-').next()?.parse().ok()?;
            n.ends_with(".json.gz").then_some((ts, e.path()))
        })
        .collect();
    snaps.sort_by(|a, b| b.0.cmp(&a.0));
    let cutoff = now_ms().saturating_sub(MAX_AGE.as_millis() as u64);
    for (i, (ts, p)) in snaps.iter().enumerate() {
        if i >= KEEP || (i >= KEEP_MIN && *ts < cutoff) {
            let _ = fs::remove_file(p);
        }
    }
}

/// 重命名后把历史跟着搬过去
pub fn rename(root: &Path, from: &Path, to: &Path) {
    let a = dir_for(root, from);
    if a.exists() {
        let _ = fs::rename(a, dir_for(root, to));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_list_read_roundtrip() {
        let root = std::env::temp_dir().join(format!("excalidesk-hist-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let doc = Path::new("/tmp/a.excalidraw");
        let els = [json!({"id":"r1","type":"rectangle","index":"a0"}), json!({"id":"i1","type":"image","fileId":"f1","index":"a1"}), json!({"id":"d","type":"rectangle","isDeleted":true})];
        let refs: Vec<&Value> = els.iter().collect();
        let mut files = Map::new();
        files.insert("f1".into(), json!({"id":"f1","dataURL":"data:image/png;base64,AAAA"}));
        let e1 = snapshot(&root, doc, &refs, &json!({"gridSize":20}), &files, "save").unwrap();
        assert_eq!(e1.elements, 2);
        std::thread::sleep(Duration::from_millis(5));
        snapshot(&root, doc, &refs[..1], &json!({}), &Map::new(), "external").unwrap();
        let l = list(&root, doc);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].reason, "external");
        let v: Value = serde_json::from_slice(&read(&root, doc, &e1.id).unwrap()).unwrap();
        assert_eq!(v["elements"].as_array().unwrap().len(), 3);
        assert_eq!(v["files"]["f1"]["dataURL"], "data:image/png;base64,AAAA");
        rename(&root, doc, Path::new("/tmp/b.excalidraw"));
        assert_eq!(list(&root, Path::new("/tmp/b.excalidraw")).len(), 2);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prune_keeps_latest_50() {
        let root = std::env::temp_dir().join(format!("excalidesk-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let doc = Path::new("/tmp/p.excalidraw");
        let dir = dir_for(&root, doc);
        fs::create_dir_all(&dir).unwrap();
        for i in 0..60u64 {
            fs::write(dir.join(format!("{}-save-1.json.gz", now_ms() - 1000 * (60 - i))), gz(b"{}")).unwrap();
        }
        prune(&dir);
        assert_eq!(list(&root, doc).len(), KEEP);
        fs::remove_dir_all(&root).unwrap();
    }
}
