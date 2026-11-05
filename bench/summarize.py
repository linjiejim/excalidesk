"""汇总 bench/results/*.json：每个环境取各轮中位数，输出 Markdown 表。用法：python3 -I bench/summarize.py [results_dir]"""
import glob, json, os, statistics, sys

d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "results")
ENVS = ["tauri-120", "tauri-60", "safari", "chrome"]
runs = {e: [] for e in ENVS}
for f in sorted(glob.glob(os.path.join(d, "*.json"))):
    name = os.path.basename(f).rsplit("-", 1)[0]
    if name in runs:
        data = json.load(open(f))
        if "tests" in data:
            runs[name].append(data)

def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None

def col(env, path):
    vals = []
    for r in runs[env]:
        v = r
        for k in path:
            v = v.get(k) if isinstance(v, dict) else None
        vals.append(v)
    return med(vals)

print("轮数：" + "，".join(f"{e} {len(runs[e])}" for e in ENVS))
for r in runs["tauri-120"][:1] + runs["tauri-60"][:1]:
    print(f"{r['env']} fpsUnlocked={r.get('tauri', {}).get('fpsUnlocked')}")
print()

FRAME_TESTS = [
    ("baseline", "空闲 rAF"),
    ("panFit", "平移 · 全图可见"),
    ("zoom", "缩放 · ctrl+滚轮"),
    ("pan30", "平移 · 30%"),
    ("pan100", "平移 · 100%"),
    ("freedraw", "手绘 · 全图可见"),
    ("panWhileSaving_ours", "100% 平移 + 保存（ours）"),
    ("panWhileSaving_ezStyle", "100% 平移 + 保存（ExcalidrawZ 式）"),
]
print("| 场景 | " + " | ".join(ENVS) + " |")
print("|---|" + "---|" * len(ENVS))
for key, label in FRAME_TESTS:
    cells = []
    for e in ENVS:
        fps, p95, mx = col(e, ["tests", key, "fps"]), col(e, ["tests", key, "p95"]), col(e, ["tests", key, "max"])
        cells.append("—" if fps is None else f"{fps} fps · p95 {p95} · max {mx}")
    print(f"| {label} | " + " | ".join(cells) + " |")

print()
print("| 指标（ms） | " + " | ".join(ENVS) + " |")
print("|---|" + "---|" * len(ENVS))
def open_col(e, i):
    return med([r["tests"]["open"][i]["totalMs"] for r in runs[e] if len(r["tests"].get("open", [])) > i])
rows = [
    ("首次打开（含字体、首帧）", lambda e: open_col(e, 0)),
    ("再次打开（中位数）", lambda e: med([statistics.median([o["totalMs"] for o in r["tests"]["open"][1:]]) for r in runs[e]])),
    ("JSON.parse + restore", lambda e: med([r["tests"]["open"][1]["parseRestoreMs"] for r in runs[e]])),
    ("getSceneVersion", lambda e: col(e, ["tests", "save", "sceneVersionMs"])),
    ("ours 冷缓存序列化", lambda e: col(e, ["tests", "save", "oursColdMs"])),
    ("ours 热缓存序列化（改 1 个元素）", lambda e: col(e, ["tests", "save", "oursWarmMs"])),
    ("朴素 stringify + encode", lambda e: col(e, ["tests", "save", "naiveStringifyEncodeMs"])),
    ("官方 serializeAsJSON（含图片）", lambda e: col(e, ["tests", "save", "officialSerializeWithFilesMs"])),
    ("ExcalidrawZ 式：同步阻塞段", lambda e: col(e, ["tests", "save", "ezStyle", "syncMs"])),
    ("ExcalidrawZ 式：全程", lambda e: col(e, ["tests", "save", "ezStyle", "totalMs"])),
    ("Tauri IPC 保存正文（往返）", lambda e: col(e, ["tests", "save", "tauriIpcElements", "roundTripMs"])),
    ("Tauri IPC 保存含图片全文（往返）", lambda e: col(e, ["tests", "save", "tauriIpcWithFiles", "roundTripMs"])),
]
for label, fn in rows:
    print(f"| {label} | " + " | ".join("—" if fn(e) is None else str(fn(e)) for e in ENVS) + " |")
b = runs["tauri-120"][0]["tests"]["save"] if runs["tauri-120"] else {}
if b:
    print(f"\n正文 {b.get('tauriIpcElements', {}).get('bytes')} 字节；含图片全文 {b.get('tauriIpcWithFiles', {}).get('bytes')} 字节")
for e in ENVS:
    created = [r["tests"]["freedraw"].get("created") for r in runs[e]]
    print(f"{e} freedraw created={created}")
