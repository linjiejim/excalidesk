//! MCP：让 Claude Code、Codex 这些 Agent 在 Excalidesk 里画图、读用户的批注和改动。
//!
//! 两个进程：
//! - `excalidesk --mcp`（bridge.rs）：Agent 拉起的 stdio MCP server。握手和工具列表自己答，
//!   第一次真正调用工具时才连 App（没开就拉起来），所以每开一个 Claude Code 会话不会顺带打开 App。
//! - App 里的 host.rs：监听 Unix socket，一条连接 = 一个 Agent。工具逻辑、文档状态、批注、基线都在这里；
//!   需要 Excalidraw 本身的事（把简化元素转成真实元素、Mermaid、渲染 PNG、放进画布）交给前端。
//!
//! socket 上是一行一个 JSON 的消息（Up / Down）。

pub mod bridge;
pub mod host;
pub mod scene;

use std::path::PathBuf;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const IDENTIFIER: &str = "dev.jim.excalidesk";

/// 和 Tauri 的 app_config_dir 一致：~/Library/Application Support/<identifier>/mcp.sock。
/// 自测用 EXCALIDESK_MCP_SOCKET 换一个，免得和正在用的 App 抢。
pub fn socket_path() -> PathBuf {
    if let Some(p) = std::env::var_os("EXCALIDESK_MCP_SOCKET") {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join("Library/Application Support").join(IDENTIFIER).join("mcp.sock")
}

/// bridge → App
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Up {
    Hello { client: Value },
    Call { id: u64, tool: String, args: Value },
    Cancel { id: u64 },
}

/// App → bridge
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Down {
    Result {
        id: u64,
        /// MCP content blocks：{"type":"text",...} / {"type":"image",...}
        content: Vec<Value>,
        #[serde(default)]
        error: bool,
    },
    /// Claude Code channels：推一条消息进 Agent 的会话（用户点「发回」且 Agent 没在等时）
    Push { content: String, meta: Value },
}

// ── 工具参数 ────────────────────────────────────────────

#[derive(Deserialize, JsonSchema, Default)]
pub struct ListArgs {
    /// Only drawings whose path contains this text (case-insensitive).
    pub query: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct OpenArgs {
    /// An existing drawing: absolute path, or relative to a workspace folder. The .excalidraw extension is optional.
    pub path: Option<String>,
    /// Create a new drawing with this name (no extension) instead of opening one. An existing name gets a number appended.
    pub create: Option<String>,
    /// Folder for `create`: absolute, or relative to the first workspace folder. Defaults to the first workspace folder.
    pub dir: Option<String>,
    /// Bring the tab to the front. Default false: it opens in the background so the user isn't interrupted.
    pub focus: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
pub struct ReadArgs {
    /// The drawing: absolute path, or relative to a workspace folder.
    pub path: String,
    /// Only this frame (id or name).
    pub frame: Option<String>,
}

#[derive(Deserialize, JsonSchema, Serialize)]
pub struct RenderArgs {
    pub path: String,
    /// Only this frame (id or name).
    pub frame: Option<String>,
    /// Only these elements.
    pub ids: Option<Vec<String>>,
    /// Longest side of the PNG in pixels. Default 1600, at most 3000.
    #[serde(rename = "maxSize")]
    pub max_size: Option<u32>,
    /// Include the user's comment notes. Default true.
    pub comments: Option<bool>,
}

#[derive(Deserialize, JsonSchema, Serialize, Clone, Copy)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Deserialize, JsonSchema, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    /// Hand-drawn look (Excalidraw default).
    Sketch,
    /// Straight lines and a plain font; suits UI wireframes.
    Clean,
}

#[derive(Deserialize, JsonSchema, Serialize)]
pub struct DrawArgs {
    pub path: String,
    /// Elements in Excalidraw skeleton format (see the tool description). Coordinates are relative to the origin.
    pub elements: Vec<Value>,
    /// Put the elements in a frame with this name. An existing frame (name or id) gets them added inside, relative to its top-left; otherwise a new frame is placed to the right of the existing content.
    pub frame: Option<String>,
    /// Origin in scene coordinates. Default: to the right of the existing content (or the frame's top-left).
    pub at: Option<Point>,
    pub style: Option<Style>,
}

#[derive(Deserialize, JsonSchema, Serialize)]
pub struct MermaidArgs {
    pub path: String,
    /// Mermaid source: flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram, gantt, timeline, quadrantChart. Other types are inserted as an image.
    pub mermaid: String,
    /// Put the diagram in a frame with this name (new, or an existing one to add to).
    pub frame: Option<String>,
    pub at: Option<Point>,
    pub style: Option<Style>,
}

#[derive(Deserialize, JsonSchema, Serialize)]
pub struct UpdateArgs {
    pub path: String,
    /// [{"id": "...", ...fields to change}]. Fields: x, y, width, height (scene coordinates), text (a text element's text, or a shape's/arrow's label), strokeColor, backgroundColor, fillStyle, strokeStyle, strokeWidth, roughness, opacity, fontSize, link, name (frames), locked, startArrowhead / endArrowhead (arrows and lines: "arrow", "triangle", "dot", "bar", null…), order ("back" sends it behind everything else in its frame, "front" brings it on top). Moving a shape moves its label; moving a frame moves what's inside. Frames have no fill: for a background, draw a rectangle inside and give it order "back". Fields that had no effect come back in `ignored` with the reason.
    pub updates: Vec<Value>,
}

#[derive(Deserialize, JsonSchema, Serialize)]
pub struct DeleteArgs {
    pub path: String,
    /// Element ids. Deleting a shape deletes its label; deleting a frame deletes what's inside.
    pub ids: Vec<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct FeedbackArgs {
    pub path: String,
    /// Also return a PNG of the drawing. Default false.
    pub render: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
pub struct WaitArgs {
    /// The drawing to wait on. Omit to wait on any drawing you've worked on in this session.
    pub path: Option<String>,
    /// Give up after this many seconds and return "no feedback yet". Default 1500, at most 3600.
    pub timeout_seconds: Option<u64>,
    /// Also return a PNG of the drawing. Default true.
    pub render: Option<bool>,
}

#[derive(Deserialize, JsonSchema, Serialize)]
pub struct ResolveItem {
    pub id: String,
    /// Short note shown on the comment, e.g. what you changed.
    pub reply: Option<String>,
}

#[derive(Deserialize, JsonSchema, Serialize)]
pub struct ResolveArgs {
    pub path: String,
    pub comments: Vec<ResolveItem>,
}

pub const INSTRUCTIONS: &str = "Excalidesk is the user's Excalidraw desktop app (macOS). Use it to sketch ideas, flows, architectures and UI prototypes that the user sees live, then reads, edits and annotates.

Loop: open_drawing (create one, or open an existing drawing) → draw / draw_mermaid, one idea or option per frame → render_drawing to check it looks right → tell the user it's ready and call wait_for_feedback (or get_feedback once they say they've annotated) → act on their comments and edits → resolve_comments with a short reply → repeat.

The user annotates by pinning comment notes to elements (they show up in get_feedback with the elements they point at) and by editing the drawing directly (reported as added / modified / removed elements). Don't delete or rewrite their comments; resolve them.

Paths are absolute or relative to a workspace folder (list_drawings shows them). Several agents may work at once, each on its own drawing; drawings you touch open in background tabs and your changes are saved like the user's own, with an undo for them.

Prefer draw_mermaid for flowcharts, sequence, class, ER and state diagrams. Use draw with style \"clean\" for UI wireframes, \"sketch\" for loose ideas. Keep text short; leave space between frames.";

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: fn() -> Value,
    pub read_only: bool,
}

fn schema<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).unwrap_or_default()
}

const DRAW_DESC: &str = r##"Add elements to a drawing. It opens in a background tab if needed; the user sees the result live and can undo it.

Elements use Excalidraw's skeleton format. Coordinates are relative to the origin (see `at` / `frame`):
- Shapes: {"type":"rectangle"|"ellipse"|"diamond", "id":"login_btn", "x":0, "y":0, "width":160, "height":48, "label":{"text":"Sign in","fontSize":16}, "backgroundColor":"#a5d8ff", "strokeColor":"#1971c2", "fillStyle":"solid", "strokeStyle":"solid"|"dashed"|"dotted", "roundness":{"type":3}}
- Text: {"type":"text", "x":0, "y":0, "text":"Title", "fontSize":28, "textAlign":"left"}
- Arrows and lines: {"type":"arrow"|"line", "x":0, "y":0, "points":[[0,0],[200,0]], "start":{"id":"a"}, "end":{"id":"b"}, "label":{"text":"yes"}, "endArrowhead":"arrow"|null}. With both start and end ids you can leave out x, y and points; the arrow is drawn between the two shapes and stays attached.
- Layering: later elements are drawn on top. Add "order":"back" to an element to put it behind everything else in its frame (backgrounds, panels, swimlanes). Frames themselves have no fill.
- Give elements short readable ids so you can update them later. Ids must not belong to a live element in this drawing (ids of deleted elements can be reused).
Colors: stroke #1e1e1e #e03131 #2f9e44 #1971c2 #f08c00 #9c36b5; fill #ffc9c9 #b2f2bb #a5d8ff #ffec99 #eebefa #e9ecef.
Returns the ids created. Call render_drawing to check the result."##;

pub fn tools() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "list_drawings",
            description: "List the .excalidraw drawings in the user's Excalidesk workspace folders (newest first) and the tabs open in the app.",
            schema: schema::<ListArgs>,
            read_only: true,
        },
        ToolDef {
            name: "open_drawing",
            description: "Open a drawing in Excalidesk, or create a new one with `create`. Opens in a background tab unless focus is true. Returns its absolute path, element count and frames.",
            schema: schema::<OpenArgs>,
            read_only: false,
        },
        ToolDef {
            name: "read_drawing",
            description: "Read a drawing as compact JSON: frames, elements {id,type,x,y,w,h,text,name,stroke,bg,style,frame,start,end,link,by} (a shape's label is its text; `by` is the agent that last wrote it) and the user's comments {id,text,targets,status,reply}. Includes unsaved edits. Also marks the drawing as seen, so get_feedback reports only what changes after this.",
            schema: schema::<ReadArgs>,
            read_only: true,
        },
        ToolDef {
            name: "render_drawing",
            description: "Render a drawing (or one frame, or some elements) to a PNG so you can see it, the user's comment notes included.",
            schema: schema::<RenderArgs>,
            read_only: true,
        },
        ToolDef { name: "draw", description: DRAW_DESC, schema: schema::<DrawArgs>, read_only: false },
        ToolDef {
            name: "draw_mermaid",
            description: "Draw a Mermaid diagram as editable Excalidraw elements (flowchart, sequence, class, ER, state, gantt, timeline, quadrant; other types become an image). Placed like `draw`. Returns the ids created.",
            schema: schema::<MermaidArgs>,
            read_only: false,
        },
        ToolDef {
            name: "update_elements",
            description: "Change existing elements: position, size, text or label, colors and style, arrowheads, layer order (front / back), link, frame name. The user can undo it. Returns `ignored` for any field that had no effect, with the reason.",
            schema: schema::<UpdateArgs>,
            read_only: false,
        },
        ToolDef {
            name: "delete_elements",
            description: "Delete elements (a shape's label and a frame's contents go with it). The user's comment notes can't be deleted; resolve them instead.",
            schema: schema::<DeleteArgs>,
            read_only: false,
        },
        ToolDef {
            name: "get_feedback",
            description: "What the user did since you last looked at this drawing: open comments (notes pinned to elements; `new` if you haven't seen them), and the elements they added, modified or removed. `sent` tells whether they pressed \"Send to agent\". Marks everything as seen.",
            schema: schema::<FeedbackArgs>,
            read_only: true,
        },
        ToolDef {
            name: "wait_for_feedback",
            description: "Wait until the user presses \"Send to agent\" in Excalidesk (for this drawing, or for any drawing you've worked on when path is left out), then return what get_feedback returns plus a PNG. Use it after presenting a proposal the user wants to review. Returns \"no feedback yet\" after timeout_seconds; call it again to keep waiting.",
            schema: schema::<WaitArgs>,
            read_only: true,
        },
        ToolDef {
            name: "resolve_comments",
            description: "Mark the user's comments as handled once you've acted on them. The note turns grey and shows your reply.",
            schema: schema::<ResolveArgs>,
            read_only: false,
        },
    ]
}

#[cfg(test)]
mod tests {
    #[test]
    fn tool_schemas_are_objects() {
        for t in super::tools() {
            let s = (t.schema)();
            assert_eq!(s["type"], "object", "{}", t.name);
        }
    }

    #[test]
    fn wire_roundtrip() {
        let up: super::Up = serde_json::from_str(r#"{"t":"call","id":3,"tool":"draw","args":{}}"#).unwrap();
        assert!(matches!(up, super::Up::Call { id: 3, .. }));
        let s = serde_json::to_string(&super::Down::Push { content: "x".into(), meta: serde_json::json!({}) }).unwrap();
        assert!(s.contains(r#""t":"push""#));
    }
}
