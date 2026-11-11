#!/usr/bin/env python3 -I
"""MCP 端到端自测：真 App + 真 `excalidesk --mcp`，扮演 Agent 走一遍「画 → 用户批注 → 发回 → 改 → 处理批注」。

用临时工作区、临时状态文件和单独的 socket，不碰正在用的 Excalidesk。App 以 --mcp-selftest 启动：
Agent 一调用 wait_for_feedback，前端就替用户给 id 为 login 的元素加一条批注并点「发回」。

用法：bench/mcp-e2e.py [App 路径，默认 src-tauri/target/release/bundle/macos/Excalidesk.app]
"""
import json, os, shutil, subprocess, sys, tempfile, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "src-tauri/target/release/bundle/macos/Excalidesk.app"
EXE = APP / "Contents/MacOS/excalidesk"
TMP = Path(tempfile.mkdtemp(prefix="excalidesk-mcp-e2e-"))
WS = TMP / "workspace"
WS.mkdir()
(WS / "sub").mkdir()
OUTSIDE = TMP / "outside.excalidraw"
OUTSIDE.write_text(json.dumps({"type": "excalidraw", "version": 2, "elements": [], "appState": {}, "files": {}}))
STATE = TMP / "state/state.json"
STATE.parent.mkdir()
STATE.write_text(json.dumps({"roots": [str(WS.resolve())], "recent": [], "viewports": {}}))
SOCK = Path("/tmp") / f"excalidesk-e2e-{os.getpid()}.sock"
ENV = {**os.environ, "EXCALIDESK_MCP_SOCKET": str(SOCK)}

results = []


def step(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {str(detail)[:300]}")


class Client:
    """最小的 MCP stdio 客户端：一行一个 JSON-RPC 消息"""

    def __init__(self, name):
        self.p = subprocess.Popen([str(EXE), "--mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV, text=True)
        self.id = 0
        self.lock = threading.Lock()
        self.pending = {}
        self.notes = []
        threading.Thread(target=self._read, daemon=True).start()
        r = self.request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": name, "version": "1"}})
        self.info = r
        self.notify("notifications/initialized")

    def _read(self):
        for line in self.p.stdout:
            m = json.loads(line)
            if "id" in m and m["id"] in self.pending:
                self.pending[m["id"]]["msg"] = m
                self.pending[m["id"]]["ev"].set()
            else:
                self.notes.append(m)

    def send(self, m):
        with self.lock:
            self.p.stdin.write(json.dumps(m) + "\n")
            self.p.stdin.flush()

    def notify(self, method, params=None):
        self.send({"jsonrpc": "2.0", "method": method, **({"params": params} if params else {})})

    def request(self, method, params=None, timeout=120):
        with self.lock:
            self.id += 1
            i = self.id
        slot = {"ev": threading.Event()}
        self.pending[i] = slot
        self.send({"jsonrpc": "2.0", "id": i, "method": method, **({"params": params} if params is not None else {})})
        if not slot["ev"].wait(timeout):
            raise TimeoutError(method)
        m = slot["msg"]
        if "error" in m:
            raise RuntimeError(m["error"])
        return m["result"]

    def call(self, tool, args, timeout=120, progress=None):
        params = {"name": tool, "arguments": args}
        if progress:
            params["_meta"] = {"progressToken": progress}
        r = self.request("tools/call", params, timeout)
        texts = [c["text"] for c in r["content"] if c["type"] == "text"]
        images = [c for c in r["content"] if c["type"] == "image"]
        return r.get("isError", False), texts, images

    def close(self):
        self.p.stdin.close()
        self.p.wait(5)


def js(texts):
    return json.loads(texts[0])


app = subprocess.Popen([str(EXE), f"--state={STATE}", "--mcp-selftest"], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(80):
        if SOCK.exists():
            break
        time.sleep(0.25)
    step("App 监听 socket", SOCK.exists(), SOCK)
    mode = oct(SOCK.stat().st_mode & 0o777) if SOCK.exists() else None
    step("socket 只有本人可读写", mode == "0o600", mode)

    a = Client("claude-code")
    step("握手：协议 2025-11-25 + channels 能力", a.info["protocolVersion"] == "2025-11-25" and "claude/channel" in a.info["capabilities"].get("experimental", {}), a.info["protocolVersion"])
    tools = [t["name"] for t in a.request("tools/list")["tools"]]
    step("11 个工具", len(tools) == 11, tools)

    err, t, _ = a.call("list_drawings", {})
    step("list_drawings 列出工作区", not err and str(WS.resolve()) in js(t)["workspaces"], t[0][:120])

    err, t, _ = a.call("open_drawing", {"create": "e2e 原型"})
    path = js(t)["path"] if not err else None
    step("open_drawing 新建", not err and path and Path(path).exists(), t)

    login = [
        {"type": "rectangle", "id": "phone", "x": 0, "y": 0, "width": 260, "height": 460},
        {"type": "text", "id": "title", "x": 24, "y": 28, "text": "Welcome back", "fontSize": 24},
        {"type": "rectangle", "id": "login", "x": 24, "y": 210, "width": 212, "height": 44, "backgroundColor": "#a5d8ff", "fillStyle": "solid", "label": {"text": "Sign in"}},
        {"type": "ellipse", "id": "home", "x": 400, "y": 200, "width": 140, "height": 70, "label": {"text": "Home"}},
        {"type": "arrow", "id": "go", "start": {"id": "login"}, "end": {"id": "home"}, "label": {"text": "ok"}},
    ]
    err, t, _ = a.call("draw", {"path": path, "elements": login, "frame": "Option A", "style": "clean"})
    step("draw：frame + 箭头绑定", not err and "login" in js(t)["created"], t[0][:200])
    err, t, _ = a.call("draw", {"path": path, "elements": [{"type": "rectangle", "id": "login", "x": 0, "y": 0, "width": 10, "height": 10}]})
    step("draw：重复 id 报错", err and "already used" in t[0], t)
    # 模型常把每个元素再编码成字符串（Codex 实测这么干过）：照样要能画
    err, t, _ = a.call("draw", {"path": path, "at": {"x": 0, "y": 600}, "elements": [json.dumps({"type": "text", "id": "hint", "x": 0, "y": 0, "text": "Forgot password?"})]})
    step("draw：元素被编码成字符串也能画", not err and "hint" in js(t)["created"], t[0][:160])
    err, t, _ = a.call("draw_mermaid",{"path": path, "frame": "Flow", "mermaid": "flowchart LR\n A[Open] --> B{Signed in?}\n B -- yes --> C[Home]\n B -- no --> D[Sign in]"})
    step("draw_mermaid", not err and len(js(t)["created"]) >= 4, t[0][:160] if t else "")

    err, t, _ = a.call("read_drawing", {"path": path})
    d = js(t) if not err else {}
    go = next((e for e in d.get("elements", []) if e["id"] == "go"), {})
    step("read_drawing：两个 frame、箭头两端", len(d.get("frames", [])) == 2 and go.get("start") == "login" and go.get("end") == "home", {"frames": d.get("frames"), "go": go})
    step("read_drawing：标签并进容器、记作者", any(e["id"] == "login" and e.get("text") == "Sign in" and e.get("by") == "Claude Code" for e in d.get("elements", [])))

    err, t, img = a.call("render_drawing", {"path": path, "frame": "Option A"})
    import base64
    png = base64.b64decode(img[0]["data"]) if img else b""
    step("render_drawing 返回 PNG", not err and png[:8] == b"\x89PNG\r\n\x1a\n", t)

    err, t, _ = a.call("get_feedback", {"path": path})
    fb = js(t)
    step("get_feedback：Agent 自己画的不算改动", not err and fb["comments"] == [] and not any(fb["changes"].values()), fb.get("summary"))

    # 「用户」（外部编辑）直接改文件：加一个矩形
    doc = json.loads(Path(path).read_text())
    doc["elements"].append({"id": "user-box", "type": "rectangle", "x": -400, "y": 0, "width": 100, "height": 60, "version": 1, "versionNonce": 1, "isDeleted": False,
                            "angle": 0, "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid", "roughness": 1,
                            "opacity": 100, "groupIds": [], "frameId": None, "roundness": None, "seed": 1, "boundElements": None, "updated": 1, "link": None, "locked": False})
    time.sleep(1.1)
    Path(path).write_text(json.dumps(doc))
    time.sleep(2.5)
    err, t, _ = a.call("get_feedback", {"path": path})
    fb = js(t)
    step("get_feedback：外部加的元素算用户改动", [e["id"] for e in fb["changes"]["added"]] == ["user-box"], fb["changes"])

    # 第二个 Agent 也看过这张图：用户点一次「发回」，两个 Agent 各自都要收到
    b = Client("codex")
    b.call("read_drawing", {"path": path})

    # 自测钩子（只演一次）：App 看到 Agent 在等，就给 login 加批注并点「发回」
    err, t, img = a.call("wait_for_feedback", {"path": path, "timeout_seconds": 60}, progress="w1")
    fb = js(t) if not err else {}
    c = (fb.get("comments") or [{}])[0]
    err, t, _ = b.call("get_feedback", {"path": path})
    fbb = js(t)
    step("另一个 Agent 也收到同一次发回", fbb.get("sent") is True and len(fbb.get("comments", [])) == 1 and fbb["comments"][0].get("new") is True, fbb.get("summary"))
    step("wait_for_feedback：收到批注和指向的元素", fb.get("sent") is True and c.get("text") == "make the button green" and c.get("targets", [{}])[0].get("id") == "login" and c.get("new") is True, fb)
    step("wait_for_feedback 附带 PNG", bool(img))
    err, t, _ = a.call("wait_for_feedback", {"path": path, "timeout_seconds": 5})
    step("wait_for_feedback 没人发回时超时返回", not err and "No feedback yet" in t[0], t)

    err, t, _ = a.call("update_elements", {"path": path, "updates": [{"id": "login", "backgroundColor": "#b2f2bb", "text": "Continue"}, {"id": "home", "x": 420, "y": 320}]})
    step("update_elements", not err and js(t)["missing"] == [], t[0][:200])
    err, t, _ = a.call("update_elements", {"path": path, "updates": [{"id": "phone", "text": "Phone"}]})
    ph = next((e for e in js(a.call("read_drawing", {"path": path})[1])["elements"] if e["id"] == "phone"), {})
    step("update_elements：给没标签的形状加标签", not err and ph.get("text") == "Phone", ph)
    err, t, _ = a.call("update_elements", {"path": path, "updates": [{"id": "phone", "text": ""}]})
    ph = next((e for e in js(a.call("read_drawing", {"path": path})[1])["elements"] if e["id"] == "phone"), {})
    step("update_elements：空字符串去掉标签", not err and "text" not in ph, t[0][:160])
    err, t, _ = a.call("delete_elements", {"path": path, "ids": [c.get("id", "?")]})
    step("delete_elements 不许删用户批注", err and "resolve_comments" in t[0], t)
    err, t, _ = a.call("resolve_comments", {"path": path, "comments": [{"id": c.get("id", "?"), "reply": "made it green"}]})
    step("resolve_comments", not err and js(t)["resolved"] == [c.get("id")], t)
    err, t, _ = a.call("read_drawing", {"path": path})
    d = js(t)
    cm = d["comments"][0] if d["comments"] else {}
    lg = next((e for e in d["elements"] if e["id"] == "login"), {})
    step("read_drawing：批注已处理、按钮已改", cm.get("status") == "resolved" and cm.get("reply") == "made it green" and lg.get("text") == "Continue" and lg.get("bg") == "#b2f2bb", {"comment": cm, "login": lg})
    err, t, _ = a.call("get_feedback", {"path": path})
    fb = js(t)
    step("get_feedback：Agent 改的不回报给自己", fb["comments"] == [] and not any(fb["changes"].values()), fb["changes"])

    # 图层顺序、复用删掉的 id、没生效的字段要报出来、箭头头部
    _, t, _ = a.call("open_drawing", {"create": "layers"})
    lp = js(t)["path"]

    def stack(fid=None):
        """文件里一个 frame 内（或不在 frame 里）的活元素，从下到上；按 index 排，同时核对数组顺序和 index 一致"""
        els = [e for e in json.loads(Path(lp).read_text())["elements"] if not e.get("isDeleted")]
        arr = [e["id"] for e in els if e.get("frameId") == fid and e["type"] != "frame"]
        by_index = [e["id"] for e in sorted(els, key=lambda e: e["index"]) if e.get("frameId") == fid and e["type"] != "frame"]
        return arr if arr == by_index else ["index 和数组顺序不一致", arr, by_index]

    err, t, _ = a.call("draw", {"path": lp, "frame": "L", "style": "clean", "elements": [
        {"type": "rectangle", "id": "c1", "x": 0, "y": 0, "width": 120, "height": 60, "label": {"text": "one"}},
        {"type": "rectangle", "id": "c2", "x": 200, "y": 0, "width": 120, "height": 60},
        {"type": "rectangle", "id": "bg", "x": -20, "y": -20, "width": 360, "height": 100, "backgroundColor": "#e9ecef", "fillStyle": "solid", "order": "back"},
        {"type": "arrow", "id": "ln", "start": {"id": "c1"}, "end": {"id": "c2"}},
    ]})
    fid = js(t)["frame"] if not err else None
    st = stack(fid)
    step("draw：order back 放到 frame 最下面", not err and st[0] == "bg" and st.index("c1") < st.index("ln"), st)
    err, t, _ = a.call("draw", {"path": lp, "elements": [{"type": "rectangle", "id": "zz", "x": 0, "y": 0, "width": 1, "height": 1, "order": "middle"}]})
    step("draw：order 写错报错", err and "order" in t[0], t)

    a.call("update_elements", {"path": lp, "updates": [{"id": "c1", "order": "front"}]})
    st = stack(fid)
    lab = next(e["id"] for e in json.loads(Path(lp).read_text())["elements"] if e.get("containerId") == "c1" and not e.get("isDeleted"))
    step("update_elements：order front，标签跟着", st[-2:] == ["c1", lab], st)
    a.call("update_elements", {"path": lp, "updates": [{"id": lab, "order": "back"}]})
    st = stack(fid)
    step("update_elements：对标签调 order 等于对容器", st[:2] == ["c1", lab], st)

    err, t, _ = a.call("update_elements", {"path": lp, "updates": [{"id": fid, "backgroundColor": "#eee", "name": "L2"}, {"id": "c2", "foo": 1, "endArrowhead": "dot"}, {"id": "ln", "endArrowhead": "triangle", "startArrowhead": "dot"}]})
    r = js(t) if not err else {}
    ig = {(i["id"], tuple(i["fields"])) for i in r.get("ignored", [])}
    raw = {e["id"]: e for e in json.loads(Path(lp).read_text())["elements"]}
    step("update_elements：没生效的字段报 ignored", ig == {(fid, ("backgroundColor",)), ("c2", ("foo",)), ("c2", ("endArrowhead",))} and raw[fid]["name"] == "L2" and raw[fid]["backgroundColor"] == "transparent", r)
    step("update_elements：箭头头部", raw["ln"]["endArrowhead"] == "triangle" and raw["ln"]["startArrowhead"] == "dot", {k: raw["ln"][k] for k in ("startArrowhead", "endArrowhead")})

    old_v = raw["c2"]["version"]
    a.call("delete_elements", {"path": lp, "ids": ["c2"]})
    err, t, _ = a.call("draw", {"path": lp, "frame": fid, "elements": [{"type": "ellipse", "id": "c2", "x": 0, "y": 0, "width": 80, "height": 80}]})
    raw = {e["id"]: e for e in json.loads(Path(lp).read_text())["elements"]}
    step("draw：删掉的 id 可以再用（版本压过删除记录、放最上面）", not err and raw["c2"]["type"] == "ellipse" and not raw["c2"].get("isDeleted") and raw["c2"]["version"] > old_v + 1 and stack(fid)[-1] == "c2", t[0][:160])
    err, t, _ = a.call("draw", {"path": lp, "elements": [{"type": "rectangle", "id": "c1", "x": 0, "y": 0, "width": 1, "height": 1}]})
    step("draw：活着的 id 仍然不许重复", err and "already used" in t[0], t)
    a.call("delete_elements", {"path": lp, "ids": ["bg"]})
    err, t, _ = a.call("draw", {"path": lp, "frame": fid, "elements": [{"type": "rectangle", "id": "bg", "x": 0, "y": 0, "width": 10, "height": 10}, {"type": "rectangle", "id": "fg", "x": 0, "y": 0, "width": 10, "height": 10}]})
    st = stack(fid)
    step("draw：复用的 id 和新 id 一起画，按请求先后叠放", not err and st[-2:] == ["bg", "fg"], st)
    a.call("update_elements", {"path": lp, "updates": [{"id": "fg", "order": "front"}, {"id": "fg", "order": "back"}]})
    st = stack(fid)
    step("update_elements：同一元素调了几次 order，最后一次算数", st[0] == "fg", st)
    err, t, _ = a.call("get_feedback", {"path": lp})
    fb = js(t)
    step("get_feedback：Agent 调图层、复用 id 都不算用户改动", not any(fb["changes"].values()), fb["changes"])

    err, t, _ = a.call("read_drawing", {"path": str(OUTSIDE)})
    step("工作区外的文件拒绝", err and "outside" in t[0], t)
    err, t, _ = a.call("open_drawing", {"create": "x", "dir": "/tmp"})
    step("工作区外不能新建", err, t)
    err, t, _ = a.call("open_drawing", {"create": "x", "dir": str(TMP / "outside-new" / "deep")})
    step("工作区外的文件夹不会被建出来", err and not (TMP / "outside-new").exists(), t)

    same = {}
    th = [threading.Thread(target=lambda cl, k: same.__setitem__(k, js(cl.call("open_drawing", {"create": "same"})[1])["path"]), args=(cl, k)) for cl, k in ((a, "a"), (b, "b"))]
    [x.start() for x in th]
    [x.join(60) for x in th]
    step("两个 Agent 同时新建同名的图，各拿一个文件", len(set(same.values())) == 2, same)

    # 多个 Agent 同时改不同的图（都不在当前标签）
    _, t1, _ = a.call("open_drawing", {"create": "agent-a", "dir": "sub"})
    _, t2, _ = b.call("open_drawing", {"create": "agent-b"})
    pa, pb = js(t1)["path"], js(t2)["path"]
    out = {}

    def work(cl, p, key):
        out[key] = [cl.call("draw_mermaid", {"path": p, "frame": f"{key} {i}", "mermaid": f"flowchart LR\n A{i}[{key} {i}] --> B{i}[done]"})[0] for i in range(3)]

    th = [threading.Thread(target=work, args=(a, pa, "A")), threading.Thread(target=work, args=(b, pb, "B"))]
    [x.start() for x in th]
    [x.join(120) for x in th]
    time.sleep(1)
    na = sum(1 for e in json.loads(Path(pa).read_text())["elements"] if e["type"] == "frame")
    nb = sum(1 for e in json.loads(Path(pb).read_text())["elements"] if e["type"] == "frame")
    step("两个 Agent 并行各画各的图，都已存盘", out.get("A") == [False] * 3 and out.get("B") == [False] * 3 and na == 3 and nb == 3, {"A": na, "B": nb})
    authors = {e.get("customData", {}).get("excalidesk", {}).get("by") for e in json.loads(Path(pb).read_text())["elements"]}
    step("作者标记区分两个 Agent", "Codex" in authors, authors)
    b.close()
    a.close()
finally:
    app.terminate()
    try:
        app.wait(5)
    except subprocess.TimeoutExpired:
        app.kill()
    shutil.rmtree(TMP, ignore_errors=True)
    SOCK.unlink(missing_ok=True)

print(f"\n{sum(results)} / {len(results)} passed")
sys.exit(0 if all(results) else 1)
