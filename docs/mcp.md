# Agent 协作（MCP）

2026-11-11

Claude Code、Codex 等 Agent 通过 MCP 在 Excalidesk 里画原型、呈现方案；用户在图上直接改或钉批注，点「发回」后 Agent 收到反馈，接着调整或落地。双向，但**发回永远由用户手动点**，不会自动发送。

## 接入

设置（⌘,）→ Agent 里有可复制的命令，路径是本机 App 的实际位置：

```bash
claude mcp add excalidesk -s user -- /Applications/Excalidesk.app/Contents/MacOS/excalidesk --mcp
```

```bash
codex mcp add excalidesk -- /Applications/Excalidesk.app/Contents/MacOS/excalidesk --mcp
```

App 没开也没关系：Agent 第一次调用工具时会在后台把它拉起来。设置里能一键关掉 Agent 访问（关掉后所有调用都被拒绝），也能看到当前连着哪些 Agent、各自在干什么。

## 一轮协作

1. Agent `open_drawing` 新建或打开一张图，`draw` / `draw_mermaid` 画方案，一个方案一个 frame，`render_drawing` 自己看一眼。
2. Agent 调 `wait_for_feedback` 等用户。底部 Agent 条上「发回给 Claude Code」变成主按钮。
3. 用户在图上：
   - **直接改**：挪、删、加、改字，都会作为 added / modified / removed 回报；
   - **批注**：选中元素按 **C**（没选就落在画布中间），输入后回车。便签自动连一根虚线箭头指向被批注的元素；
   - Agent 条上「n 条批注」可在未处理的批注之间跳转。
4. 用户点「发回」。在等的 Agent 立刻拿到：未处理的批注（连同指向的元素）、用户的改动、一张带批注的 PNG。
5. Agent 改图（`update_elements` / `draw` / `delete_elements`），处理完的批注 `resolve_comments` 并附一句回复：便签变灰，显示「✓ Agent: 回复」。

Agent 没在等时点「发回」：先记下来，下次 `wait_for_feedback` / `get_feedback` 会看到 `sent: true`；同时给碰过这张图的 Agent 推一条提醒（`notifications/claude/channel`，只有用 `claude --dangerously-load-development-channels server:excalidesk` 启动的 Claude Code 会话收得到）。也可以直接在 Agent 那边说「看下批注」。

## 工具

| 工具 | 作用 |
|---|---|
| `list_drawings` | 工作区里的图（新的在前）和已打开的标签 |
| `open_drawing` | 打开或新建（`create` + 可选 `dir`），默认后台标签 |
| `read_drawing` | 紧凑 JSON：frames、元素 `{id,type,x,y,w,h,text,…,by}`、批注；并把当前状态记为「看过」 |
| `render_drawing` | 整张 / 一个 frame / 几个元素 → PNG |
| `draw` | Excalidraw skeleton 格式加元素：`frame` 自动排到已有内容右边，`style` 选 clean / sketch，箭头按 id 绑定 |
| `draw_mermaid` | Mermaid → 可编辑元素（流程图、时序图等） |
| `update_elements` | 改位置、尺寸、文字 / 标签、颜色样式、链接、frame 名；连着的箭头跟着重新走线 |
| `delete_elements` | 删元素（标签、frame 内容一起）；用户批注不许删 |
| `get_feedback` | 上次看过之后用户的批注和改动 |
| `wait_for_feedback` | 等用户点「发回」，返回 get_feedback 的内容 + PNG；超时返回「还没有反馈」 |
| `resolve_comments` | 标记批注已处理并回复 |

写操作和用户自己的编辑走同一条保存路径（增量、原子写、历史留档），标签上会出现横幅「Claude Code 改了 n 个元素 · 撤销」。

## 多个 Agent

- 一条 socket 连接就是一个 Agent，名字取自 MCP 握手的 `clientInfo`（claude-code → Claude Code，codex → Codex）。
- Agent 碰到的图在**后台标签**打开，不抢当前标签；标签上一个紫点，切过去就消失。
- 同一张图的操作按到达顺序串行，不同的图并行。实测两个 Agent 同时各画 3 个 frame 到两张不在前台的图，互不干扰。
- 两个 Agent 改同一张图也行：反馈状态（基线、有没有收到「发回」）按「Agent 名 + 图」分开记，用户点一次「发回」，碰过这张图的每个 Agent 都能收到；正在等的被唤醒，没在等的收到提醒。
- 用户和 Agent 同时改：Agent 的写操作先等保存和留档做完，再**同步地**读画布、算改动、放进去，中间不让出线程，所以不会盖掉用户刚做的编辑（包括挪了同一个元素）。用户在 Agent 操作途中关掉这张图，这次操作作废并告诉 Agent 重试。
- 元素记作者：`customData.excalidesk.by`。

## 「只回报用户的改动」

每个 Agent 看过的每张图都有一份基线（简化后的元素快照，按「Agent 名 + 图」存在状态目录 `mcp/` 下）。`read_drawing`、`get_feedback` 会刷新它；Agent 自己写入的元素直接并进基线，所以回报里只有用户做的事。比较时忽略 2px 以内的位置抖动。

## 架构

```
Agent ──stdio MCP──▶ excalidesk --mcp ──Unix socket──▶ Excalidesk App ──事件──▶ 前端（Excalidraw）
```

- `excalidesk --mcp`（`src-tauri/src/mcp/bridge.rs`）：用 rmcp 实现 stdio MCP server，只做转发。协议版本封顶 2025-11-25，声明实验能力 `claude/channel`；长时间等待时每 15 秒发一次 progress，避免 Claude Code 的 stdio 空闲超时。
- socket：`~/Library/Application Support/dev.jim.excalidesk/mcp.sock`，权限 0600，可用 `EXCALIDESK_MCP_SOCKET` 覆盖（测试用）。线上格式是一行一个 JSON。已有一个 Excalidesk 在服务时，后开的（比如开发版）让出。
- App 侧（`src-tauri/src/mcp/host.rs`）：路径检查、基线、等待和发回；需要画布的操作发事件给前端执行（`src/shell/agent.ts`），前端回 `mcp_reply`。
- 简化场景、算差异（`src-tauri/src/mcp/scene.rs`）在 Rust 里，有单元测试。

## 边界

- 只能读写工作区文件夹里的图，或者已经在标签里打开的图。路径先 `canonicalize` 再判断，符号链接绕不出去。
- socket 只有当前用户能连。
- 批注存在 `.excalidraw` 文件里（`customData.excalidesk.comment`），所以跟着文件走（iCloud、git、别的设备都看得到）；导出 PNG / SVG 时自动去掉，用 excalidraw.com 打开就是普通便签。
- 批注快捷键 C：Excalidraw 只在 ⌘⌥C、⌥⇧C 上用了 C，单按 C 是空的。

## 验证

- `cargo test --lib mcp`：9 个（场景简化、差异、基线吸收、参数解包、新文件夹路径解析、协议往返）。
- `bench/mcp-e2e.py`：真 App + 真 `--mcp` 进程，临时工作区和单独 socket，32 步全过。App 以 `--mcp-selftest` 启动，Agent 一进入等待，前端就替用户给 id 为 `login` 的元素加批注并点「发回」（只演一次）。覆盖：握手、新建、画（含元素被编码成字符串）、重复 id、Mermaid、读、渲染、外部修改算用户改动、等待并收到批注、两个 Agent 各自收到同一次发回、改图、加 / 去标签、不许删批注、处理批注、Agent 自己的改动不回报、工作区外拒绝（不建文件夹）、同时新建同名图、两个 Agent 并行。
- 浏览器预览里用 `window.__agent` 验过并发场景：Agent 写入途中用户加元素、挪同一个元素、删 frame 时里面的批注、同一批先加标签再挪容器、操作途中关掉图。
- Codex 审了 3 轮（`codex review --uncommitted`，后两轮只看修复）：第 1 轮 9 条、第 2 轮 6 条、第 3 轮 1 条，全部修了；没有留下未修的。
- 用真 Agent 跑过一轮：`codex exec`（临时 `-c mcp_servers.excalidesk…`，没改全局配置）画了手机登录页 → 等反馈 → 收到「make the button green」→ 改绿 → 回复并处理批注。它第一次把元素编码成 JSON 字符串传进来被拒，之后服务端改成自动解包。
- `claude -p` 那轮没跑成：本机 Claude Code CLI 的登录过期了。
- 老的端到端自测 22 步照旧全过；`--selftest` 模式不再监听 MCP socket，免得 Agent 连到测试实例上。

## 没做

- 自动发回（按要求不做）。
- 批注的回复线程：现在是一条批注 + Agent 一句回复。
- Windows / Linux：socket 路径和后台拉起 App 只写了 macOS。
