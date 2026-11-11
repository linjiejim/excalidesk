//! 给 Agent 看的场景：把 Excalidraw 元素压成精简形式，抽出批注，和「Agent 上次看到的样子」（基线）做对比。
//! 纯函数，不碰文件和窗口。

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 精简元素：坐标取整，默认样式不写，绑定在容器里的文字并进容器的 text
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct SEl {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// frame 的名字
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    /// dashed / dotted
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    /// 箭头两端绑定的元素
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// 最后一次是哪个 Agent 写的（人改过之后仍保留，只作参考）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Comment {
    pub id: String,
    pub text: String,
    pub targets: Vec<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    pub x: i64,
    pub y: i64,
}

#[derive(Default, Debug, Clone)]
pub struct Scene {
    pub elements: Vec<SEl>,
    pub comments: Vec<Comment>,
}

/// Agent 上次看过（读、写、取反馈）时的样子
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Baseline {
    pub at: u64,
    pub elements: HashMap<String, SEl>,
    pub comments: HashSet<String>,
}

fn s<'a>(e: &'a Value, k: &str) -> Option<&'a str> {
    e.get(k).and_then(Value::as_str)
}
fn n(e: &Value, k: &str) -> i64 {
    e.get(k).and_then(Value::as_f64).unwrap_or(0.0).round() as i64
}
fn ext<'a>(e: &'a Value) -> Option<&'a Value> {
    e.get("customData").and_then(|c| c.get("excalidesk"))
}
pub fn is_deleted(e: &Value) -> bool {
    e.get("isDeleted").and_then(Value::as_bool).unwrap_or(false)
}
/// 批注便签本身（矩形）
pub fn comment_meta(e: &Value) -> Option<&Value> {
    ext(e).and_then(|x| x.get("comment"))
}
/// 批注的附属元素：便签里的文字、指向目标的箭头
pub fn comment_part_of(e: &Value) -> Option<&str> {
    ext(e).and_then(|x| x.get("commentOf")).and_then(Value::as_str)
}

pub fn simplify(elements: &[Value]) -> Scene {
    let live: Vec<&Value> = elements.iter().filter(|e| !is_deleted(e)).collect();
    // 容器 id → 绑定在里面的文字
    let mut labels: HashMap<&str, &str> = HashMap::new();
    for e in &live {
        if s(e, "type") == Some("text") {
            if let (Some(c), Some(t)) = (s(e, "containerId"), text_of(e)) {
                labels.insert(c, t);
            }
        }
    }
    let mut out = Scene::default();
    for e in &live {
        let Some(id) = s(e, "id") else { continue };
        let kind = s(e, "type").unwrap_or("");
        if kind == "selection" || comment_part_of(e).is_some() {
            continue;
        }
        if let Some(meta) = comment_meta(e) {
            out.comments.push(Comment {
                id: id.into(),
                text: labels.get(id).map(|t| strip_reply(t).to_string()).unwrap_or_default(),
                targets: meta
                    .get("targets")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                    .unwrap_or_default(),
                status: meta.get("status").and_then(Value::as_str).unwrap_or("open").into(),
                reply: meta.get("reply").and_then(Value::as_str).map(String::from),
                x: n(e, "x"),
                y: n(e, "y"),
            });
            continue;
        }
        if kind == "text" && s(e, "containerId").is_some_and(|c| live.iter().any(|x| s(x, "id") == Some(c))) {
            continue;
        }
        let text = if kind == "text" { text_of(e).map(String::from) } else { labels.get(id).map(|t| t.to_string()) };
        let stroke = s(e, "strokeColor").filter(|c| *c != "#1e1e1e" && *c != "#000000").map(String::from);
        let bg = s(e, "backgroundColor").filter(|c| *c != "transparent").map(String::from);
        let style = s(e, "strokeStyle").filter(|c| *c != "solid").map(String::from);
        let bind = |k: &str| e.get(k).and_then(|b| b.get("elementId")).and_then(Value::as_str).map(String::from);
        out.elements.push(SEl {
            id: id.into(),
            kind: kind.into(),
            x: n(e, "x"),
            y: n(e, "y"),
            w: n(e, "width"),
            h: n(e, "height"),
            text,
            name: if kind == "frame" || kind == "magicframe" { s(e, "name").map(String::from) } else { None },
            stroke,
            bg,
            style,
            frame: s(e, "frameId").map(String::from),
            start: bind("startBinding"),
            end: bind("endBinding"),
            link: s(e, "link").map(String::from),
            by: ext(e).and_then(|x| x.get("by")).and_then(Value::as_str).map(String::from),
        });
    }
    out
}

fn text_of(e: &Value) -> Option<&str> {
    s(e, "originalText").or_else(|| s(e, "text"))
}

/// 已处理的批注会在文字末尾追加 Agent 的回复，读批注原文时去掉
pub const REPLY_SEP: &str = "\n——\n";
fn strip_reply(t: &str) -> &str {
    t.split(REPLY_SEP).next().unwrap_or(t)
}

impl Scene {
    pub fn baseline(&self, at: u64) -> Baseline {
        Baseline {
            at,
            elements: self.elements.iter().map(|e| (e.id.clone(), e.clone())).collect(),
            comments: self.comments.iter().map(|c| c.id.clone()).collect(),
        }
    }

    /// 只限某个 frame（按 id 或名字）
    pub fn only_frame(&mut self, frame: &str) -> Result<(), String> {
        let id = self
            .elements
            .iter()
            .find(|e| (e.kind == "frame" || e.kind == "magicframe") && (e.id == frame || e.name.as_deref() == Some(frame)))
            .map(|e| e.id.clone())
            .ok_or_else(|| format!("no frame named or with id {frame:?}"))?;
        let keep: HashSet<String> = self.elements.iter().filter(|e| e.id == id || e.frame.as_deref() == Some(&id)).map(|e| e.id.clone()).collect();
        self.elements.retain(|e| keep.contains(&e.id));
        self.comments.retain(|c| c.targets.iter().any(|t| keep.contains(t)));
        Ok(())
    }
}

/// 把基线里这些 id 换成现在的样子（Agent 自己写过的元素不算「用户改的」），其余保持不变
pub fn absorb(base: &mut Baseline, now: &Scene, ids: &HashSet<String>) {
    for id in ids {
        match now.elements.iter().find(|e| &e.id == id) {
            Some(e) => {
                base.elements.insert(id.clone(), e.clone());
            }
            None => {
                base.elements.remove(id);
            }
        }
        if now.comments.iter().any(|c| &c.id == id) {
            base.comments.insert(id.clone());
        }
    }
}

const TOL: i64 = 2;

fn brief(e: &SEl) -> Value {
    let mut v = json!({ "id": e.id, "type": e.kind });
    if let Some(t) = &e.text {
        v["text"] = json!(clip(t, 80));
    }
    if let Some(n) = &e.name {
        v["name"] = json!(n);
    }
    v
}

fn clip(t: &str, max: usize) -> String {
    if t.chars().count() <= max { t.to_string() } else { format!("{}…", t.chars().take(max).collect::<String>()) }
}

fn opt(v: &Option<String>) -> String {
    v.as_deref().map(|t| format!("{:?}", clip(t, 80))).unwrap_or_else(|| "none".into())
}

/// 描述一个元素变了什么，没有实质变化（只是版本号、绑定这类内部字段）返回空
pub fn describe(a: &SEl, b: &SEl) -> Vec<String> {
    let mut c = Vec::new();
    if (a.x - b.x).abs() > TOL || (a.y - b.y).abs() > TOL {
        c.push(format!("moved ({},{}) → ({},{})", a.x, a.y, b.x, b.y));
    }
    if (a.w - b.w).abs() > TOL || (a.h - b.h).abs() > TOL {
        c.push(format!("resized {}×{} → {}×{}", a.w, a.h, b.w, b.h));
    }
    if a.kind != b.kind {
        c.push(format!("type {} → {}", a.kind, b.kind));
    }
    let mut field = |name: &str, x: &Option<String>, y: &Option<String>| {
        if x != y {
            c.push(format!("{name}: {} → {}", opt(x), opt(y)));
        }
    };
    field("text", &a.text, &b.text);
    field("name", &a.name, &b.name);
    field("stroke", &a.stroke, &b.stroke);
    field("bg", &a.bg, &b.bg);
    field("style", &a.style, &b.style);
    field("frame", &a.frame, &b.frame);
    field("start", &a.start, &b.start);
    field("end", &a.end, &b.end);
    field("link", &a.link, &b.link);
    c
}

/// 反馈：未处理的批注 + 自基线以来的改动
pub fn feedback(base: Option<&Baseline>, now: &Scene) -> Value {
    let by_id: HashMap<&str, &SEl> = now.elements.iter().map(|e| (e.id.as_str(), e)).collect();
    let open: Vec<Value> = now
        .comments
        .iter()
        .filter(|c| c.status != "resolved")
        .map(|c| {
            let targets: Vec<Value> = c
                .targets
                .iter()
                .map(|t| by_id.get(t.as_str()).map(|e| brief(e)).unwrap_or_else(|| json!({ "id": t, "missing": true })))
                .collect();
            json!({
                "id": c.id,
                "text": c.text,
                "targets": targets,
                "new": base.is_some_and(|b| !b.comments.contains(&c.id)),
                "at": [c.x, c.y],
            })
        })
        .collect();
    let Some(base) = base else {
        return json!({
            "comments": open,
            "changes": null,
            "note": "No earlier snapshot of this drawing, so changes can't be listed. Call read_drawing to see it as it is now.",
        });
    };
    let mut added = Vec::new();
    let mut modified = Vec::new();
    for e in &now.elements {
        match base.elements.get(&e.id) {
            None => added.push(serde_json::to_value(e).unwrap_or_default()),
            Some(old) => {
                let what = describe(old, e);
                if !what.is_empty() {
                    let mut v = brief(e);
                    v["changes"] = json!(what);
                    modified.push(v);
                }
            }
        }
    }
    let mut removed: Vec<Value> = base.elements.values().filter(|e| !by_id.contains_key(e.id.as_str())).map(brief).collect();
    removed.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    json!({
        "comments": open,
        "changes": { "added": added, "modified": modified, "removed": removed },
    })
}

/// read_drawing 的输出：frame 概览 + 元素 + 批注；元素太多就截断
pub fn overview(scene: &Scene, limit: usize) -> Value {
    let frames: Vec<Value> = scene
        .elements
        .iter()
        .filter(|e| e.kind == "frame" || e.kind == "magicframe")
        .map(|f| {
            let n = scene.elements.iter().filter(|e| e.frame.as_deref() == Some(&f.id)).count();
            json!({ "id": f.id, "name": f.name, "x": f.x, "y": f.y, "w": f.w, "h": f.h, "elements": n })
        })
        .collect();
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    for e in &scene.elements {
        *kinds.entry(e.kind.as_str()).or_default() += 1;
    }
    let truncated = scene.elements.len() > limit;
    let mut v = json!({
        "count": scene.elements.len(),
        "types": kinds,
        "frames": frames,
        "elements": scene.elements.iter().take(limit).collect::<Vec<_>>(),
        "comments": scene.comments,
    });
    if let Some((x0, y0, x1, y1)) = bounds(&scene.elements) {
        v["bounds"] = json!({ "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0 });
    }
    if truncated {
        v["truncated"] = json!(format!("Only the first {limit} of {} elements are listed. Pass `frame` to read one frame at a time.", scene.elements.len()));
    }
    v
}

pub fn bounds(els: &[SEl]) -> Option<(i64, i64, i64, i64)> {
    let mut it = els.iter();
    let f = it.next()?;
    let mut b = (f.x.min(f.x + f.w), f.y.min(f.y + f.h), f.x.max(f.x + f.w), f.y.max(f.y + f.h));
    for e in it {
        b.0 = b.0.min(e.x.min(e.x + e.w));
        b.1 = b.1.min(e.y.min(e.y + e.h));
        b.2 = b.2.max(e.x.max(e.x + e.w));
        b.3 = b.3.max(e.y.max(e.y + e.h));
    }
    Some(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(id: &str, x: f64) -> Value {
        json!({ "id": id, "type": "rectangle", "x": x, "y": 0, "width": 100, "height": 50, "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "strokeStyle": "solid", "version": 1 })
    }
    fn label(id: &str, container: &str, text: &str) -> Value {
        json!({ "id": id, "type": "text", "x": 10, "y": 10, "width": 40, "height": 20, "containerId": container, "text": text, "originalText": text })
    }

    #[test]
    fn folds_labels_and_skips_deleted() {
        let mut gone = rect("c", 0.0);
        gone["isDeleted"] = json!(true);
        let s = simplify(&[rect("a", 0.4), label("t", "a", "Login"), gone]);
        assert_eq!(s.elements.len(), 1);
        assert_eq!(s.elements[0].text.as_deref(), Some("Login"));
        assert_eq!(s.elements[0].stroke, None);
    }

    #[test]
    fn comments_are_split_out() {
        let mut note = rect("n", 200.0);
        note["customData"] = json!({ "excalidesk": { "comment": { "targets": ["a"], "status": "open" } } });
        let mut arrow = json!({ "id": "ar", "type": "arrow", "x": 0, "y": 0, "width": 1, "height": 1 });
        arrow["customData"] = json!({ "excalidesk": { "commentOf": "n" } });
        let mut text = label("nt", "n", &format!("make it blue{REPLY_SEP}✓ done"));
        text["customData"] = json!({ "excalidesk": { "commentOf": "n" } });
        let s = simplify(&[rect("a", 0.0), note, arrow, text]);
        assert_eq!(s.elements.len(), 1);
        assert_eq!(s.comments.len(), 1);
        assert_eq!(s.comments[0].text, "make it blue");
        assert_eq!(s.comments[0].targets, vec!["a".to_string()]);
    }

    #[test]
    fn feedback_lists_real_changes_only() {
        let before = simplify(&[rect("a", 0.0), rect("b", 300.0), rect("gone", 600.0)]);
        let base = before.baseline(1);
        let mut moved = rect("b", 400.0);
        moved["version"] = json!(9);
        let mut jitter = rect("a", 1.0);
        jitter["boundElements"] = json!([{ "id": "x", "type": "arrow" }]);
        let now = simplify(&[jitter, moved, rect("new", 900.0)]);
        let f = feedback(Some(&base), &now);
        let ch = &f["changes"];
        assert_eq!(ch["added"].as_array().unwrap().len(), 1);
        assert_eq!(ch["modified"].as_array().unwrap().len(), 1);
        assert_eq!(ch["modified"][0]["id"], "b");
        assert_eq!(ch["removed"][0]["id"], "gone");
    }

    #[test]
    fn absorb_only_touches_given_ids() {
        let before = simplify(&[rect("a", 0.0), rect("b", 0.0)]);
        let mut base = before.baseline(1);
        let now = simplify(&[rect("a", 500.0), rect("b", 500.0), rect("agent", 0.0)]);
        absorb(&mut base, &now, &["a".to_string(), "agent".to_string()].into_iter().collect());
        let f = feedback(Some(&base), &now);
        assert_eq!(f["changes"]["modified"].as_array().unwrap().len(), 1);
        assert_eq!(f["changes"]["modified"][0]["id"], "b");
        assert!(f["changes"]["added"].as_array().unwrap().is_empty());
    }

    #[test]
    fn only_frame_filters() {
        let mut f = json!({ "id": "f1", "type": "frame", "name": "A", "x": 0, "y": 0, "width": 500, "height": 500 });
        f["name"] = json!("方案 A");
        let mut inside = rect("in", 10.0);
        inside["frameId"] = json!("f1");
        let mut s = simplify(&[f, inside, rect("out", 900.0)]);
        s.only_frame("方案 A").unwrap();
        assert_eq!(s.elements.len(), 2);
        assert!(s.only_frame("nope").is_err());
    }
}
