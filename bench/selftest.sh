#!/bin/zsh
# 构建（离线用缓存的 crate）+ 跑端到端自测，打印每一步结果。--no-build 跳过构建
cd "${0:A:h}/.."
if [[ "$1" != "--no-build" ]]; then
  CARGO_NET_OFFLINE=true npx tauri build --bundles app 2>&1 | grep -E "^error|error\[|Finished 1 bundle" | head -20
fi
rm -f bench/results/selftest-*.json /tmp/excalidesk-selftest-state.json
open -n -W src-tauri/target/release/bundle/macos/Excalidesk.app --args --selftest --state=/tmp/excalidesk-selftest-state.json --env=selftest --results="$PWD/bench/results" --autoquit
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
