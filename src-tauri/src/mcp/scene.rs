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
    /// 按放映顺序的页（备注 frame 不算）
    pub slides: Vec<SlideInfo>,
    /// 备注 frame → 它归属的页
    pub notes_owner: HashMap<String, String>,
}

/// 演示文稿里的一页。规则和前端 src/shell/slides.ts 一样（docs/specs/20261117-presentation-mode.md），改一边要改另一边
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SlideInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    /// 固定尺寸页（customData.excalidesk.slide）：Agent 往里加东西不撑大
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub fixed: bool,
    /// 演讲者备注的文字
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(rename = "notesFrame", skip_serializing_if = "Option::is_none")]
    pub notes_frame: Option<String>,
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
    let (slides, owner) = slides(&live);
    out.slides = slides;
    out.notes_owner = owner;
    out
}

struct Fr<'a> {
    id: &'a str,
    name: Option<&'a str>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    fixed: bool,
    notes_for: Option<&'a str>,
}

fn f(e: &Value, k: &str) -> f64 {
    e.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

/// 带 notesFor 的 frame，或名字是「备注 / Notes」整个词（后面没别的或跟着分隔符，手画的）是备注。
/// 固定页（slide 标记）永远是页，名字叫什么都不算
fn is_notes(fr: &Fr) -> bool {
    if fr.fixed {
        return false;
    }
    let n = fr.name.unwrap_or("").trim_start();
    let rest = n.strip_prefix("备注").or_else(|| n.get(..5).filter(|h| h.eq_ignore_ascii_case("notes")).map(|_| &n[5..]));
    let name_says = rest.is_some_and(|r| {
        let r = r.trim_start();
        r.is_empty() || r.starts_with(['·', ':', '：', '-', '—', '–', '(', '（', '|', '/'])
    });
    fr.notes_for.is_some() || name_says
}

/// 先行后列：按顶边排，垂直中线落在当前行上下范围内的归进这一行，行内从左到右
fn order<'a, 'b>(mut frames: Vec<&'b Fr<'a>>) -> Vec<&'b Fr<'a>> {
    let cmp = |a: f64, b: f64| a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal);
    frames.sort_by(|a, b| cmp(a.y, b.y).then(cmp(a.x, b.x)));
    let mut rows: Vec<(f64, f64, Vec<&Fr>)> = Vec::new();
    for fr in frames {
        let cy = fr.y + fr.h / 2.0;
        match rows.last_mut() {
            Some((top, bottom, items)) if cy >= *top && cy <= *bottom => {
                items.push(fr);
                *bottom = bottom.max(fr.y + fr.h);
            }
            _ => rows.push((fr.y, fr.y + fr.h, vec![fr])),
        }
    }
    rows.into_iter()
        .flat_map(|(_, _, mut items)| {
            items.sort_by(|a, b| cmp(a.x, b.x).then(cmp(a.y, b.y)));
            items
        })
        .collect()
}

/// 备注归哪一页：正上方最近的一页优先（复制页 + 备注时 notesFor 还指着原来那页）；正上方没有页才用 notesFor
fn owner_of<'a>(n: &Fr, slides: &[&Fr<'a>]) -> Option<&'a str> {
    let cx = n.x + n.w / 2.0;
    let mut best: Option<(&'a str, f64)> = None;
    for s in slides {
        if cx < s.x || cx > s.x + s.w || n.y < s.y + s.h / 2.0 {
            continue;
        }
        let gap = (n.y - (s.y + s.h)).abs();
        if best.is_none_or(|(_, g)| gap < g) {
            best = Some((s.id, gap));
        }
    }
    best.map(|(id, _)| id).or_else(|| n.notes_for.and_then(|id| slides.iter().find(|s| s.id == id).map(|s| s.id)))
}

fn slides(live: &[&Value]) -> (Vec<SlideInfo>, HashMap<String, String>) {
    let frames: Vec<Fr> = live
        .iter()
        .filter(|e| matches!(s(e, "type"), Some("frame" | "magicframe")))
        .filter_map(|e| {
            let (x, y, w, h) = (f(e, "x"), f(e, "y"), f(e, "width"), f(e, "height"));
            Some(Fr {
                id: s(e, "id")?,
                name: s(e, "name"),
                x: x.min(x + w),
                y: y.min(y + h),
                w: w.abs(),
                h: h.abs(),
                fixed: ext(e).and_then(|x| x.get("slide")).and_then(Value::as_bool).unwrap_or(false),
                notes_for: ext(e).and_then(|x| x.get("notesFor")).and_then(Value::as_str),
            })
        })
        .collect();
    let slides = order(frames.iter().filter(|fr| !is_notes(fr)).collect());
    let mut owner: HashMap<String, String> = HashMap::new();
    let mut notes: Vec<&Fr> = frames.iter().filter(|fr| is_notes(fr)).collect();
    notes.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));
    for n in &notes {
        if let Some(o) = owner_of(n, &slides) {
            owner.insert(n.id.to_string(), o.to_string());
        }
    }
    // 备注 frame 里的文字（含形状里的标签），按 y、x 排
    let frame_of: HashMap<&str, &str> = live.iter().filter_map(|e| Some((s(e, "id")?, s(e, "frameId")?))).collect();
    let texts_in = |nid: &str| -> String {
        let mut ts: Vec<&&Value> = live
            .iter()
            .filter(|e| s(e, "type") == Some("text") && comment_part_of(e).is_none())
            .filter(|e| s(e, "frameId") == Some(nid) || s(e, "containerId").and_then(|c| frame_of.get(c)) == Some(&nid))
            .collect();
        ts.sort_by(|a, b| f(a, "y").partial_cmp(&f(b, "y")).unwrap_or(std::cmp::Ordering::Equal).then(f(a, "x").partial_cmp(&f(b, "x")).unwrap_or(std::cmp::Ordering::Equal)));
        ts.iter().filter_map(|e| text_of(e)).map(str::trim).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n\n")
    };
    let list = slides
        .iter()
        .map(|sl| {
            let mine: Vec<&&Fr> = notes.iter().filter(|n| owner.get(n.id).map(String::as_str) == Some(sl.id)).collect();
            let text = mine.iter().map(|n| texts_in(n.id)).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n\n");
            SlideInfo {
                id: sl.id.to_string(),
                name: sl.name.map(String::from),
                x: sl.x.round() as i64,
                y: sl.y.round() as i64,
                w: sl.w.round() as i64,
                h: sl.h.round() as i64,
                fixed: sl.fixed,
                notes: (!text.is_empty()).then_some(text),
                notes_frame: mine.first().map(|n| n.id.to_string()),
            }
        })
        .collect();
    (list, owner)
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
            let mut v = json!({ "id": f.id, "name": f.name, "x": f.x, "y": f.y, "w": f.w, "h": f.h, "elements": n });
            if let Some(o) = scene.notes_owner.get(&f.id) {
                v["notesFor"] = json!(o);
            }
            v
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
    if !scene.slides.is_empty() {
        v["slides"] = json!(scene.slides);
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

    fn frame(id: &str, name: &str, x: f64, y: f64, w: f64, h: f64) -> Value {
        json!({ "id": id, "type": "frame", "name": name, "x": x, "y": y, "width": w, "height": h })
    }
    fn text_in(id: &str, frame: &str, y: f64, t: &str) -> Value {
        json!({ "id": id, "type": "text", "x": 0, "y": y, "width": 10, "height": 10, "frameId": frame, "text": t, "originalText": t })
    }
    fn order_of(s: &Scene) -> Vec<&str> {
        s.slides.iter().map(|x| x.id.as_str()).collect()
    }

    #[test]
    fn slides_play_row_by_row() {
        // 第二行先画、第一行的两页反着画、高矮不一：还是先行后列
        let s = simplify(&[
            frame("c", "C", 0.0, 2000.0, 1920.0, 1080.0),
            frame("b", "B", 2080.0, 100.0, 1920.0, 800.0),
            frame("a", "A", 0.0, 0.0, 1920.0, 1080.0),
        ]);
        assert_eq!(order_of(&s), vec!["a", "b", "c"]);
    }

    #[test]
    fn notes_pair_by_geometry_then_id() {
        let mut marked = frame("n1", "Notes", 0.0, 1160.0, 1920.0, 480.0);
        marked["customData"] = json!({ "excalidesk": { "notesFor": "a" } });
        // 复制页 + 备注：notesFor 还指着 a，但它在 b 的正下方
        let mut copied = frame("n2", "Notes", 2080.0, 1160.0, 1920.0, 480.0);
        copied["customData"] = json!({ "excalidesk": { "notesFor": "a" } });
        // 页挪走了、备注没跟：正上方没有页，退回 notesFor
        let mut stray = frame("n3", "备注", 9000.0, 5000.0, 1920.0, 480.0);
        stray["customData"] = json!({ "excalidesk": { "notesFor": "c" } });
        let s = simplify(&[
            frame("a", "A", 0.0, 0.0, 1920.0, 1080.0),
            frame("b", "B", 2080.0, 0.0, 1920.0, 1080.0),
            frame("c", "C", 4160.0, 0.0, 1920.0, 1080.0),
            marked,
            copied,
            stray,
            // 手画的、只靠名字认出来的备注
            frame("hand", "备注 · 第二页", 2100.0, 1300.0, 1800.0, 300.0),
            text_in("t1", "n1", 1200.0, "first"),
            text_in("t3", "n2", 1300.0, "second, lower"),
            text_in("t2", "n2", 1200.0, "second"),
            text_in("t4", "n3", 5100.0, "third"),
            text_in("t5", "hand", 1350.0, "by hand"),
        ]);
        assert_eq!(order_of(&s), vec!["a", "b", "c"]);
        assert_eq!(s.slides[0].notes.as_deref(), Some("first"));
        assert_eq!(s.slides[1].notes.as_deref(), Some("second\n\nsecond, lower\n\nby hand"));
        assert_eq!(s.slides[1].notes_frame.as_deref(), Some("n2"));
        assert_eq!(s.slides[2].notes.as_deref(), Some("third"));
        assert_eq!(s.notes_owner.get("hand").map(String::as_str), Some("b"));
        let v = overview(&s, 100);
        assert_eq!(v["slides"].as_array().unwrap().len(), 3);
        assert_eq!(v["frames"].as_array().unwrap().iter().filter(|f| f.get("notesFor").is_some()).count(), 4);
    }

    #[test]
    fn notes_by_name_only_whole_word() {
        let mut fixed = frame("f", "Notes & references", 0.0, 0.0, 1920.0, 1080.0);
        fixed["customData"] = json!({ "excalidesk": { "slide": true } });
        let mut fixed_plain = frame("g", "备注", 2080.0, 0.0, 1920.0, 1080.0);
        fixed_plain["customData"] = json!({ "excalidesk": { "slide": true } });
        let s = simplify(&[
            fixed,
            fixed_plain,
            frame("app", "Notes app redesign", 4160.0, 0.0, 1920.0, 1080.0),
            frame("n1", "notes: intro", 0.0, 1160.0, 1920.0, 400.0),
            frame("n2", "备注（第二页）", 2080.0, 1160.0, 1920.0, 400.0),
        ]);
        assert_eq!(order_of(&s), vec!["f", "g", "app"]);
        assert_eq!(s.notes_owner.get("n1").map(String::as_str), Some("f"));
        assert_eq!(s.notes_owner.get("n2").map(String::as_str), Some("g"));
    }

    #[test]
    fn fixed_slides_are_marked() {
        let mut a = frame("a", "A", 0.0, 0.0, 1920.0, 1080.0);
        a["customData"] = json!({ "excalidesk": { "slide": true } });
        let s = simplify(&[a, frame("b", "B", 2080.0, 0.0, 800.0, 600.0)]);
        assert!(s.slides[0].fixed);
        assert!(!s.slides[1].fixed);
        assert!(s.slides[0].notes.is_none());
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
