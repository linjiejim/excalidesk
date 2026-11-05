#!/bin/zsh
# 依次跑 Tauri(120) / Tauri(60) / Safari / Chrome，每个环境 N 轮；浏览器结果由 vite preview 的 /__bench 落盘
cd "${0:A:h}/.."
RES="${PWD}/bench/results"
APP="${PWD}/src-tauri/target/release/bundle/macos/ExcalidrawP0.app"
ROUNDS=${1:-2}
wait_for() { # $1=前缀 $2=开始前的文件数
  for i in {1..150}; do
    n=$(ls "$RES" 2>/dev/null | grep -c "^$1-")
    [[ $n -gt $2 ]] && return 0
    sleep 1
  done
  echo "timeout waiting for $1"; return 1
}
for r in $(seq 1 $ROUNDS); do
  for fps in 120 60; do
    echo "round $r tauri-$fps"
    open -n -W "$APP" --args --bench --fps=$fps --env=tauri-$fps --results="$RES" --autoquit
  done
  for b in safari chrome; do
    before=$(ls "$RES" | grep -c "^$b-")
    echo "round $r $b"
    if [[ $b == safari ]]; then open -a Safari "http://localhost:4173/?bench=1&env=safari"
    else open -a "Google Chrome" "http://localhost:4173/?bench=1&env=chrome"; fi
    wait_for $b $before
    sleep 2
  done
done
echo done
