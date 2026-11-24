#!/bin/zsh
# 构建（离线用缓存的 crate）+ 跑端到端自测，打印每一步结果。
# 默认无头：窗口停在屏幕外、不抢前台、Dock 里没有图标（src-tauri/src/headless.rs）。
# --no-build 跳过构建；--show 用正常窗口跑，看得见过程（会抢前台、演示那步会进全屏）
cd "${0:A:h}/.."
build=1 open_flags=(-g) app_flags=(--headless)
for a in "$@"; do
  case $a in
    --no-build) build=0 ;;
    --show) open_flags=() app_flags=() ;;
    *) echo "selftest.sh: unknown option $a (use --no-build, --show)" >&2; exit 2 ;;
  esac
done
if (( build )); then
  CARGO_NET_OFFLINE=true npx tauri build --bundles app 2>&1 | grep -E "^error|error\[|Finished 1 bundle" | head -20
fi
rm -rf bench/results/selftest-*.json /tmp/excalidesk-selftest-state
open $open_flags -n -W src-tauri/target/release/bundle/macos/Excalidesk.app --args --selftest $app_flags --state=/tmp/excalidesk-selftest-state/state.json --env=selftest --results="$PWD/bench/results" --autoquit
python3 -I - <<'PY'
import json, glob
f = sorted(glob.glob("bench/results/selftest-*.json"))[-1]
d = json.load(open(f))
print(f"{d['passed']} / {d['total']}")
for s in d["steps"]:
    detail = s.get("detail")
    if s["ok"]:
        print(f"PASS {s['ms']:>5}ms {s['name']}  {json.dumps(detail, ensure_ascii=False)[:160]}")
    else:
        print(f"FAIL {s['ms']:>5}ms {s['name']}  {json.dumps(detail, ensure_ascii=False)[:900]}")
PY
