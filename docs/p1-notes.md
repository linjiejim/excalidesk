# P1 MVP：Excalidesk

2026-11-06 · P0 的基准代码在 `src/bench/` 和 `bench/`。应用暂名 **Excalidesk**，bundle id `dev.jim.excalidesk`。

## 能用了什么

| 功能 | 状态 | 说明 |
|---|---|---|
| 工作区（多个文件夹） | ✅ | 侧边栏列出所有 `.excalidraw`（最深 6 层，跳过隐藏目录和 `node_modules`）；移除只是从侧边栏拿掉，不删文件 |
| 首次启动选存储位置 | ✅ | 「iCloud Drive」会在 iCloud Drive 里建 `Excalidraw/` 文件夹；也可以选本地文件夹 |
| 标签页 | ✅ | 切换时保存并记住视口；⇧⌘] / ⇧⌘[ 切换，⌘W 关闭，中键关闭 |
| 自动保存 | ✅ | 防抖 800ms、最长 5s；切标签、窗口失焦、⌘S、关标签、退出时立即保存 |
| 增量保存 | ✅ | 会话里第一次发全量，之后只发 version 变了的元素和新图片；Rust 维护整张图，按 fractional index 排序，协调写 + 原子 rename |
| 外部修改 | ✅ | FSEvents 监听；本地没改动 → 直接载入新版本；有未保存改动 → `reconcileElements` 按元素合并后立即保存，横幅提示，⌘Z 可撤销 |
| iCloud 状态 | ✅ | 状态栏显示「等待上传 / 正在上传 / 已同步 / 有冲突版本」；侧边栏用 ☁︎ 标出仅在云端的文件，打开时显示「正在从 iCloud 下载…」 |
| 视口 | ✅ | 按文件记在 App 自己的状态文件里，不写进 `.excalidraw` |
| 双击打开 / 拖到 Dock | ✅ | 注册了 `.excalidraw` 文件关联；冷启动和已在运行两种情况都测过 |
| 原生菜单 | ✅ | 新建 ⌘N、打开 ⌘O、添加文件夹 ⇧⌘O、保存 ⌘S、导出 PNG ⇧⌘E / SVG、在 Finder 中显示 ⇧⌘R、侧边栏 ⌘\、专注模式 ⌘. |
| 导出 | ✅ | PNG（2 倍分辨率）、SVG，走系统保存对话框 |
| 深浅色 | ✅ | 跟随系统，外壳和画布一起切换 |
| 120Hz | ✅ | 默认开启（P0 的私有 API 方案） |
| 退出保护 | ✅ | 关窗 / ⌘Q 先保存所有文档；有保存失败的会拦一次并提示 |

## 验证

- **Rust 单元测试 5 个**：增量合并与排序、只保留仍被引用的图片、空文件、目录扫描（含 `.icloud` 占位文件）、路径解码。
- **端到端自测 12 步**（`bench/selftest.sh`，在真实 App 里跑，用临时目录），连续 3 次 12/12：

| 步骤 | 结果 |
|---|---|
| 准备工作区并扫描文件树 | ✅ |
| 打开小图 | ✅ 111ms |
| 编辑后自动保存（会话首次 = 全量） | ✅ 3 个元素，1.4KB |
| 第二次编辑只发 1 个元素 | ✅ 564 字节 |
| 外部修改（本地无改动）→ 自动载入 | ✅ 约 1.6s（含模拟写入时故意等的 1.1s） |
| 外部修改（本地有未保存改动）→ 按元素合并并保存 | ✅ 本地和外部的元素都在，已写盘 |
| 打开 3000 个元素的大图 | ✅ 192ms |
| 切回小图，内容和视口都还在 | ✅ |
| 新建图（放在当前文件所在的文件夹） | ✅ |
| 导出 PNG / SVG | ✅ |
| 关闭标签前保存 | ✅ |
| 保存出的文件是合法的 `.excalidraw`（有 index、按 index 排序） | ✅ |

- **文件关联**：`open -a Excalidesk 文件` 的冷启动和热启动都能打开，并写进最近打开。
- **P0 基准回归**：P1 构建里跑基准，100% 平移 119fps、全图可见平移 11fps、手绘 120fps，和 P0 一致。
- **界面**：在内置浏览器里用假数据（`src/shell/mockIpc.ts`）看过深色和浅色两种模式。

## 开发中修掉的两个坑（值得记住）

1. **Excalidraw 在构造函数里调用 `excalidrawAPI`。** 被 React 丢弃的那次 render 也会调用（加载中文语言包时就会发生），拿到的 api 属于一个从没挂载的实例，对它 `updateScene` 屏幕上没有任何变化。现在的做法是把 api 都记成候选，由 `onChange` 确认：`onChange` 只由已挂载的实例触发，它收到的 elements 和那个实例 `getSceneElementsIncludingDeleted()` 返回的是同一个数组。
2. **FSEvents 报告的是真实路径**（`/var` → `/private/var`）。打开文件和添加文件夹时统一先转成真实路径，否则外部修改永远匹配不上。

## 已知问题和没做的

- **打开文件后可能马上写一次盘：** 字体加载完，Excalidraw 会重新测量文字尺寸并改版本号。Excalidraw 自己存的文件一般不会触发，文字尺寸不准的文件会。后续可以把「只有文字尺寸变了」的情况识别出来不存。
- **没有重命名、删除、移动文件**（要在 Finder 里做，侧边栏会自动刷新）。
- **没有 iCloud 冲突版本（`NSFileVersion`）的处理界面**，只在状态栏提示；P2 做。
- **没有本地历史版本**，P2 做。
- **全图可见时 WebKit 慢的问题**还在（P0 的结论），P2 前要决定走哪条路。
- **没有签名和公证**：现在是 ad-hoc 签名，只能在本机用；发给别人需要 Developer ID。
- **用菜单打开的保存 / 打开对话框，以及 Excalidraw 自己的复制粘贴**都还没有手动点过；自测覆盖的是数据流，交互需要你实际用一用。

## 怎么用

```bash
open "src-tauri/target/release/bundle/macos/Excalidesk.app"
```

重新构建（cargo 用离线模式，直接用本机缓存的 crate，绕开慢的网络）：

```bash
CARGO_NET_OFFLINE=true npx tauri build --bundles app
```

跑自测：

```bash
bench/selftest.sh
```

浏览器里看界面（用假数据）：

```bash
npm run build && npm run preview
```

## 代码结构

```
src-tauri/src/
  lib.rs        命令、启动、退出保护、文件打开事件
  doc.rs        文档内存模型、增量合并、序列化、协调读写（含单测）
  workspace.rs  状态文件、目录扫描、FSEvents 监听（含单测）
  icloud.rs     NSFileCoordinator、同步状态、P0 iCloud 自检
  menu.rs       原生菜单
  fps.rs        解锁 120Hz
src/shell/
  session.ts    DocSession：脏检测、保存调度、delta、外部修改合并、视口
  actions.ts    工作区、标签、新建、导出、监听、退出
  store.ts      外壳状态（useSyncExternalStore）
  Shell.tsx     侧边栏、标签栏、状态栏、欢迎页
  Editor.tsx    Excalidraw 实例
  ipc.ts        Rust 命令封装（浏览器里自动换成 mockIpc.ts）
  selftest.ts   端到端自测
```
