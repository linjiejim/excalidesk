# Excalidraw × Tauri 桌面版：可行性调研与方案

2026-11-04 · 目标：Excalidraw 的 macOS 桌面壳，读写本地文件、iCloud 同步，留好以后扩展的口子；参考 ExcalidrawZ，但要更快。

---

## 0. 结论

**能做，推荐路线：Tauri 2 稳定版 + React + `@excalidraw/excalidraw` 0.18.1（锁版本）+ Rust 文件层，用纯 `.excalidraw` 文件夹做存储，iCloud 分两步上。**

1. **换成 Tauri 本身不会让画布变快。** Tauri 在 macOS 上用的就是系统 WKWebView，和 ExcalidrawZ 是同一个引擎。性能只能从「壳」这一层赢，具体是下面三件事。
2. **第一件：解锁 120Hz（已在你机器上实测）。** WKWebView 默认把 `requestAnimationFrame` 压在 60fps，Chrome 不压（P0 实测：Safari 26.2 在这台机器上也是 60fps）。在你的 M1 Pro + ProMotion + macOS 26.2 上：默认 59.6 / 60.4 fps（每帧 17ms），关掉 `PreferPageRenderingUpdatesNear60FPSEnabled` 后 117.4 / 119.9 fps（每帧 8ms）。有说法称 macOS 26 已取消这个限制，在你机器上并非如此。ExcalidrawZ 的仓库里也搜不到解锁代码。Excalidraw 的画布重绘是 rAF 驱动的，平移、缩放、拖动时的「跟手感」直接受这个影响。P0 实测：100% 缩放下平移和手绘，Tauri 解锁后是 120fps，和 Chrome 一样；Safari、未解锁的 WKWebView 是 60fps，详见 [p0-results.md](p0-results.md)。测试脚本见 `bench/wkfps.swift`。
3. **第二件：保存链路不跨桥搬全量。** `onChange` 触发非常频繁（光标移动、选中、滚动都会触发），每次只做 O(n) 的版本号比对；真改了才防抖保存，图片只在第一次出现时过一次桥，Rust 侧负责拼装和原子写盘。
4. **第三件：存储就是文件。** 不用 CoreData / CloudKit 数据库；文件夹里的 `.excalidraw` 本身就是唯一的真相，iCloud Drive 负责同步，excalidraw.com、Obsidian、git 都能直接用。
5. **iCloud 分两步：** P1 让工作区可以是任意文件夹（包括 iCloud Drive 里的），不需要开发者账号和 entitlement；P2 再做 App 自己的 iCloud 容器（Finder 里 iCloud Drive 下出现带图标的文件夹，iPad 版共用），需要 Apple 开发者账号 + 描述文件。
6. **多设备冲突可以按元素自动合并：** Excalidraw 导出了协作用的 `reconcileElements`，每个元素自带 `version` / `versionNonce`，拿它做文件级合并，大多数冲突不用弹窗。
7. **P0 已验证（2026-11-05）：** 日常编辑 Tauri 120Hz 和 Chrome 打平；但全图可见（3000 个元素同屏）时，WebKit 平移只有 13fps，Chrome 是 24fps。这是 WebKit 本身的弱点，列入 P1 风险。原先的判断是：如果瓶颈其实在 WebKit 的 Canvas 渲染（比如上千条手绘笔迹），换壳救不了。所以第一步先花 2–3 天做性能对比实验（P0），用同一张大图比较 ExcalidrawZ、Safari、Chrome 和新壳。退路是 Tauri 3 的 CEF（Chromium）运行时：2026-09 起已发 alpha，架构上保持「与 WebView 无关」，以后可以切换。

---

## 1. Tauri 能不能换来性能

| 方案 | macOS 渲染引擎 | 安装包 | 成熟度 | 说明 |
|---|---|---|---|---|
| ExcalidrawZ（SwiftUI + WKWebView） | WebKit | 中 | 成熟 | 原生集成最好 |
| **Tauri 2 + WKWebView（推荐）** | WebKit | 约 10MB 量级 | 稳定 | 和 ExcalidrawZ 同一个引擎；Rust 侧可以直接调 Foundation API |
| Tauri 3 + CEF | Chromium | 大（自带 Chromium） | alpha（`tauri-runtime-cef` 3.0.0-alpha.x，2026-09 起） | 渲染和 Chrome 一致；目前不适合当正式产品的底座 |
| Electron | Chromium | 约 150MB+ | 成熟 | 性能可预期，但体积和内存大，也偏离「用 Tauri」的初衷 |

实测（`bench/wkfps.swift`，在一个可见的 WKWebView 窗口里跑 3 秒 rAF 动画）：

| 配置 | rAF 帧率 | 帧间隔中位数 |
|---|---|---|
| WKWebView 默认 | 59.6 / 60.4 fps | 17 ms |
| 关掉 `PreferPageRenderingUpdatesNear60FPSEnabled` | 117.4 / 119.9 fps | 8 ms |

做法：通过私有 API `+[WKPreferences _features]` 和 `-[WKPreferences _setEnabled:forFeature:]` 在 WebView 创建前关掉这个开关。现成插件是 `tauri-plugin-macos-fps` 0.1（也可以照 spike 自己写，约 20 行）。代价是用了私有 API，不能上 Mac App Store；也要用 `respondsToSelector:` 做防御，系统改了就自动降级回 60fps。Tauri 官方 issue #13978 已按「not planned」关闭，官方不会提供这个开关。

**结论：** Tauri 和 ExcalidrawZ 在「引擎」这一层打平；新壳要赢，靠的是 120Hz、保存链路、存储方式和更轻的外壳 UI。

---

## 2. ExcalidrawZ：拆解与借鉴

调研对象是 [chocoford/ExcalidrawZ](https://github.com/chocoford/ExcalidrawZ) main 分支 v2.5.1（2026-10-24 发布），以及它 fork 的 Excalidraw（`chocoford/excalidraw` 的 `ExcalidrawZ-core` 分支，比上游多 164 个提交）。只读了源码，没有运行。

### 2.1 它是怎么搭的

- **Swift 侧：** 窗口、侧栏、存储、同步、导出、AI / MCP。**Web 侧：** fork 版 Excalidraw 加一个 `window.excalidrawZHelper` 桥接对象（42 个桥接模块）。
- **Excalidraw 来源：** 打包进 App 的本地 build，由 App 内的回环 HTTP 服务（FlyingFox，`127.0.0.1:8487`）提供，WebView 用非持久化数据存储。
- **存储：** 元数据放 CoreData（通过 `NSPersistentCloudKitContainer` 走 CloudKit 同步）；内容 JSON 已经迁出 CoreData，放在 `Application Support/FileStorage`，再排队上传到 iCloud 容器。图片抽出来按 id 去重，单独存储。
- **冲突：** 按修改时间判定（±2s 容差），新的覆盖旧的；只有「关联文件夹」用 `NSFileVersion` 给出选择界面。
- **文件：** 支持库内文件、关联的本地文件夹、临时打开的外部文件、协作房间、各种云盘；注册了 `.excalidraw`、`.excalidraw.png/.svg`、`.excalidrawlib`；多窗口，没有标签页。

### 2.2 性能瓶颈（按可能性排序；除注明外都是读源码后的推断）

1. **刷新率被压在 60fps。** 在它的仓库里搜不到 `PreferPageRenderingUpdatesNear60FPSEnabled` 或 `_features`，说明它没有解锁；按第 1 节的实测，ProMotion 屏上它只有 60fps，而 Chrome 里是 120fps（Safari 也是 60fps）。这是「手感不如 Chrome 里的网页版」最直接的原因，而且和数据量无关。
2. **带图的大文档，全量跨桥。** 有改动时，Swift 每隔 1–5s 拉一次全量快照。JS 端 `JSON.stringify({elements, appState, files})`，**默认包含图片**（图片本来就是 dataURL，又被 base64 一次），切成 64KB 分片逐条 `postMessage`。Swift 端每条消息都要递归清洗、`JSONSerialization` 和 `JSONDecoder`。之后还要写整份 JSON、做一次 CoreData save、重建 Spotlight 索引，并覆盖 checkpoint（又写一次整文件）。2.2.1 之前是每 2s 一次全量轮询，更慢，「性能差」的口碑可能来自那时。
3. **全库图片常驻内存。** WebView 启动时把全库所有图片一次性灌进 IndexedDB（非持久化，所以都在内存里）；打开文件要等注入完成；新增一张图就触发全量重灌。
4. **滚动 / 缩放每帧都过桥。** `onCameraChanged` 只去重、不节流（源码确认：fork `camera.js` 的 `onScrollChange` 每次都 `sendMessage`）；Swift 端每次都更新一个 `@Published`，持有它的 SwiftUI 视图会跟着失效；日志还被转发两次。
5. **SwiftUI 过度刷新。** 全局 `FileState` 有 23 个 `@Published`，每次保存都调用 `objectWillChange.send()`。
6. **主 WebView 身兼多职。** 封面和素材库预览的导出跟编辑抢同一个 JS 线程。
7. **加载方式。** Swift → JS 加载文件时，把字节数组当作数组字面量直接拼进 JS 源码执行，大文件解析成本高。

相关 issue：[#89 同步时整个画布被遮住](https://github.com/chocoford/ExcalidrawZ/issues/89) · [#115 首次同步卡死](https://github.com/chocoford/ExcalidrawZ/issues/115) · [#110 加图片后画布被重置](https://github.com/chocoford/ExcalidrawZ/issues/110) · [#113 滚轮缩放卡顿（旧版）](https://github.com/chocoford/ExcalidrawZ/issues/113)

### 2.3 借鉴什么、避开什么

| 借鉴 | 在新方案里的位置 |
|---|---|
| 脏检测用 id + version 哈希，onChange 只发元数据 | 5.2，并且更进一步：比对在 JS 本地完成，不过桥 |
| 用 revision 防止旧快照覆盖新内容；加载时用 requestId / generation 加抑制，防止空场景覆盖真文件 | 5.2 保存链路、5.1 切换标签 |
| **视口单独存在本地 sidecar，不进同步内容** | 5.3：视口（scrollX / scrollY / zoom）存到 App 自己的状态库，不写进 `.excalidraw`，避免两台设备互相改文件 |
| appState 只在语义变化时才写 | 5.2 |
| 图片按 id 去重 | 5.2：图片只在第一次出现时过桥，Rust 侧按 fileId 缓存 |
| checkpoint 文件历史 | 5.6 本地历史快照 |
| 封面磁盘缓存，按 revision 失效 | 5.8 缩略图缓存 |
| **Quick Look 扩展不用 WebView，用 SwiftUI Canvas 原生渲染** | 第 7 节 Quick Look：直接参考它的 `NativeRenderer` 思路 |
| Spotlight 索引、可编辑的 png/svg 导出、Mermaid / PDF / LaTeX、MCP、多云盘 | 第 7 节拓展清单 |

| 避开 | 新方案的做法 |
|---|---|
| 快照默认带图片、base64 套 base64 | 图片增量，二进制请求体 |
| 把二进制拼进 JS 源码 | 用 Tauri `Channel` / 原始响应 / 自定义协议传字节 |
| camera 事件每帧过桥 | 视口变化不过桥，空闲时才落盘 |
| 全库图片预灌进 WebView | 只加载当前文档引用的图片 |
| 主编辑器 WebView 兼职导出封面 | 保存后空闲时生成，或者以后用原生渲染 |
| 内容和元数据分两条同步通道（CloudKit + iCloud Drive），按时间戳覆盖 | 只有文件一条通道；按元素合并，而不是整份覆盖 |
| 不做 fork | 用官方 npm 包加 props / API 扩展；跟上游的成本低很多。ExcalidrawZ 为了 PDF 元素等功能维护了一个大 fork，需要定期合并上游 |

---

## 3. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 壳 | Tauri 2 稳定版 | 体积小；Rust 侧通过 `objc2-foundation` 直接调 `NSFileCoordinator` / `NSFileVersion` / `NSFilePresenter`，不用另写 Swift |
| 前端 | Vite + React 19 + TypeScript | Excalidraw 官方 React 组件 |
| 画板 | `@excalidraw/excalidraw` **0.18.1 锁死** | 0.18.1 是 2026-04 的安全补丁版。`@next` 有已知性能回退（#12437：frame 内手绘每次重绘整个静态场景，从 3ms 变成 30ms+），升级前先跑基准 |
| 外壳状态 | zustand（按 selector 订阅） | 外壳状态变化不能连带重渲染 Excalidraw |
| Rust 插件 | dialog、window-state、single-instance、updater、opener | 都是官方插件；文件读写自己写 command，不用 `plugin-fs` 的通用接口（要走文件协调和原子写） |
| 文件监听 | `notify`（FSEvents） | 监听外部修改和 iCloud 下行 |
| 120Hz | `tauri-plugin-macos-fps` 或自己实现 | 见第 1 节 |
| 分发 | Developer ID 签名 + 公证 + DMG + updater | 私有 API 和 iCloud 都能用；不上 Mac App Store |

---

## 4. 架构

```
┌──────────────────────────── WKWebView（每个窗口一个）────────────────────────────┐
│  外壳 UI（React）                     │  Excalidraw 画板（官方组件，memo 隔离）     │
│  侧边栏 / 标签 / 状态栏 / 对话框       │  onChange → 版本号比对 → 脏标记            │
│  zustand store                        │  SaveScheduler：防抖 + 闲时序列化           │
└───────────────▲───────────────────────┴──────────────────┬──────────────────────┘
                │ 事件：文件变化、同步状态、打开请求          │ invoke（二进制请求体）
┌───────────────┴──────────────────────── Rust 核心 ────────▼──────────────────────┐
│  Workspace     工作区根目录、文件树索引、FSEvents 增量更新                         │
│  DocStore      每个打开文档的图片缓存；拼装 .excalidraw；原子写；识别自己写的回声   │
│  SyncBridge    NSFileCoordinator 读写、未下载文件检测与下载、NSFileVersion 冲突     │
│  History       每个文件的本地快照（zstd），保留 30 天或 50 个版本                   │
│  ThumbCache    缩略图缓存 + 自定义协议 thumb://                                    │
└───────────────────────────────────────┬──────────────────────────────────────────┘
                                        │ 普通文件 IO
                 ┌──────────────────────┴───────────────────────┐
                 │ iCloud Drive 文件夹 / 任意本地文件夹 / 自有容器 │  ← 文件就是唯一的真相
                 └──────────────────────────────────────────────┘
```

分工原则：**Web 层只负责画和交互，Rust 层掌管「文件真相」**（路径、读写、监听、协调、历史）。这样以后不管换 CEF，还是做 iPad 版（Tauri iOS）、MCP，都只换一层。

---

## 5. 关键设计

### 5.1 嵌入 Excalidraw

- **完全离线：** 把 `dist/prod/fonts` 拷进前端静态资源，设置 `window.EXCALIDRAW_ASSET_PATH`（0.18 起字体不再内置，不设置会走 CDN）。中日韩字体按 unicode-range 分片，用到才加载。
- **用原生菜单替换 Excalidraw 自己的文件操作：** 通过 `<MainMenu>` 自定义，去掉「打开 / 保存到…」，改成原生菜单的 ⌘O / ⌘S / 导出。
- **Excalidraw 组件隔离：** `UIOptions`、`initialData` 等 props 要保持引用稳定（`useMemo`），组件外包一层 `memo`；外壳的 store 变化不能让它重渲染。
- **拖放：** 窗口配置 `dragDropEnabled: false`，否则 Tauri 会截走 HTML5 drop，图片拖不进画布。拖入的是 `.excalidraw` 文件时，在前端识别后改成「打开」。
- **标签页：** 每个窗口只有一个 Excalidraw 实例，切换标签时按 `key=docId` 重新挂载，场景数据缓存在内存。代价是切换后撤销历史会丢，P1 接受；要保留的话，可以让最近 2–3 个标签的实例在后台继续挂载（拿内存换）。
- **深色模式：** 跟随系统，同时设置 Excalidraw 的 `theme` 和窗口主题。

### 5.2 保存链路（性能核心）

```
onChange(elements, appState, files)        ← 每秒可能触发几十次
  ├─ v = getSceneVersion(elements)         ← O(n) 累加 version，很便宜
  ├─ 需要持久化的 appState 字段（背景色、网格等）做浅比较
  └─ 都没变 → return                        ← 选中、滚动、缩放都在这里结束

脏了 → SaveScheduler：防抖 800ms，最长 5s 必存
  ├─ delta = version 或 versionNonce 变了的元素（P0 实测：整份序列化 3000 个元素要 17ms，按元素缓存后也要 11ms，都超过 120Hz 一帧的 8.3ms；只发变化的元素才稳定在 1ms 以内）
  ├─ body = JSON.stringify(delta) + 需要持久化的 appState；Rust 维护整张图的元素表
  ├─ newFiles = 本文档还没送过的 fileId（Excalidraw 的图片按 id 不可变）
  └─ invoke('save_doc', 二进制请求体)       ← tauri::ipc::Request 原始请求体，不嵌套 JSON

Rust DocStore
  ├─ 把 delta 合并进元素表，再加上图片缓存，拼成标准 .excalidraw（serde，2 空格缩进，和官方一致，git diff 友好）
  ├─ NSFileCoordinator 协调写：写临时文件 → rename（原子）
  ├─ 记下刚写的 (mtime, hash)，忽略自己引起的 FSEvents 回声
  └─ 节流写一份历史快照
```

还要在这些时机立即保存：⌘S、切换标签、窗口失焦、退出（`RunEvent::ExitRequested` 时通知前端立即保存并等待完成）。

性能预算（P0 实测后定稿）：`onChange` 处理 p95 < 1ms；3000 个元素的序列化 < 16ms；保存过程中不出现 > 50ms 的长任务；图片 base64 永远不重复序列化。

### 5.3 文件格式

- **主格式：标准 `.excalidraw`**（`type: "excalidraw"`, `version: 2`），和 excalidraw.com、Obsidian 插件互相兼容。
- **保留删除标记（墓碑）：** 已删除的元素保留 `isDeleted: true` 若干天（默认 14 天）再清理。这是多设备按元素合并正确的前提，否则另一台设备会把删掉的元素「合并回来」。官方编辑器能正常打开这种文件（删除态的元素不渲染）。导出时可以选「清理」。
- **可选配套文件：** `.excalidraw.svg` / `.excalidraw.png`（嵌入场景），GitHub、Finder 里能直接预览，也能拖回来继续编辑。
- **视口不写进文件：** scrollX / scrollY / zoom 存在 App 自己的状态库里，按文件路径记录。这样只是滚动一下，不会改文件、触发 iCloud 上传，也不会让两台设备互相覆盖视口（借鉴 ExcalidrawZ）。
- **缩略图不写进文件：** 放 `~/Library/Caches/<bundle-id>/thumbs/`，按（路径 + mtime + 大小）作缓存键。

### 5.4 工作区与文件管理

- **工作区 = 一个或多个文件夹根目录。** Rust 扫描后建索引，FSEvents 增量更新；超大文件夹的列表用虚拟滚动。
- **文件关联：** `bundle.fileAssociations` 声明 `.excalidraw`（MIME 用 `application/vnd.excalidraw+json`）。macOS 上双击文件走 `RunEvent::Opened`，冷启动也一样，所以 **主窗口在代码里创建**，不要在配置里静态声明，否则会出现「先开一个空窗口、再开文件」的双窗口问题。
- **游离文档：** 双击工作区外的文件，作为「外部文件」标签打开，侧边栏不收录。
- **最近打开：** 写入系统的 Open Recent（`NSDocumentController noteNewRecentDocumentURL:`，通过 `objc2-app-kit` 调用），Dock 右键也能看到。
- **权限（待 P0 验证）：** 非沙盒 + Developer ID。`~/Documents`、`~/Desktop`、iCloud Drive 都受 TCC 保护：通过 `NSOpenPanel` 选中的文件夹直接获得授权；之后重启再访问可能弹系统授权框，要实测体验。如果以后要上沙盒，就得改用 security-scoped bookmark。

### 5.5 iCloud 同步

**P1：iCloud Drive 里的普通文件夹（不需要 entitlement）**

- 工作区默认建议放在 `~/Library/Mobile Documents/com~apple~CloudDocs/Excalidraw/`，同步交给系统。
- **未下载的文件：** 从 Sonoma 起，iCloud Drive 基于 FileProvider，没下载的文件是「无数据文件（dataless）」：文件名和大小都在，`stat` 的 `st_flags` 带 `SF_DATALESS`（老系统是 `.名字.icloud` 占位文件，两种都要识别）。列表里显示「仅在 iCloud」；打开时走协调读，会触发按需下载，期间显示进度，不能卡住 UI。
- **写：** 统一走 `NSFileCoordinator`，避免和系统同步进程抢同一个文件。
- **同步状态：** 读 URL 资源值 `ubiquitousItemDownloadingStatus` / `ubiquitousItemIsUploading` / `ubiquitousItemIsUploaded` / `ubiquitousItemHasUnresolvedConflicts`，驱动状态栏和列表上的图标。

**P2：App 自己的 iCloud 容器 `iCloud.<bundle-id>`**

- 效果：iCloud Drive 里出现带 App 图标的文件夹；不触发 TCC；可以用 `NSMetadataQuery` 一次拿到整个容器的同步状态；iPad 版共用同一个容器。
- 前提：Apple Developer Program；带 iCloud 能力的 **Developer ID 描述文件**；entitlements 里写 `com.apple.developer.icloud-container-identifiers`、`com.apple.developer.icloud-services = CloudDocuments`、`com.apple.developer.ubiquity-container-identifiers`，环境设为 Production；`Info.plist` 声明 `NSUbiquitousContainers`。
- Tauri 配置：`bundle.macOS.entitlements` + `bundle.macOS.files` 放 `embedded.provisionprofile`。
- 坑：只有签名后的 `tauri build` 产物才生效，`tauri dev` 里测不了（#15144）；**不要用 sidecar**，打包器会给 sidecar 签上同样的 entitlement，导致启动即崩（#16211）。

**不做：CloudKit 数据库同步。** 数据不再是文件，别的工具打不开，迁移和排错成本都高。

### 5.6 外部修改与冲突合并

```
FSEvents：文件变了
  ├─ 是自己刚写的？（mtime + hash 对上）→ 忽略
  ├─ 本地没有未保存的修改 → 读新内容 → updateScene 整体替换（保留视口位置）
  └─ 本地有未保存的修改 → merged = reconcileElements(local, remote, appState)
        → updateScene(merged)，作为一步可撤销的操作
        → 横幅提示「已按元素合并 N 处 · 撤销合并」→ 立即保存

iCloud 真冲突（NSFileVersion.unresolvedConflictVersions 不为空）
  └─ 把所有版本依次 reconcile → 写回合并结果 → 把冲突版本标为已解决并移除
     只有分歧很大（比如超过 30% 的元素冲突）或设置了「总是询问」时才弹对话框（见草图 3）
```

- `reconcileElements` 的规则：对每个元素，`version` 大的一方胜；`version` 相同时取 `versionNonce` 较小的一方，结果确定；本地正在编辑的元素不会被远端覆盖。它是 Excalidraw 官方导出的 API，实时协作就靠它。
- **兜底：** 每次保存都节流写一份本地历史快照，提供「历史版本」面板。就算 iCloud 吞了数据，也能找回来。

### 5.7 窗口、菜单、快捷键

- 原生菜单：文件（新建、打开、最近、保存、另存、导出 PNG / SVG、复制为 PNG）、编辑、视图（侧边栏、专注模式、深色）、窗口。
- ⌘⇧N 新窗口；⌘. 专注模式（隐藏侧边栏和标签栏）；以后支持把标签拖出来变成新窗口。
- 单实例：第二次启动时把要打开的文件转交给已运行的实例。

### 5.8 性能专项清单

| 项 | 做法 |
|---|---|
| 刷新率 | 解锁 120Hz（实测 60 → 120fps） |
| WebView 数量 | 每个窗口一个；后台标签不保留实例（或只保留最近 2–3 个） |
| 保存 | 见 5.2：版本号比对、防抖、闲时序列化、图片只送一次、二进制请求、Rust 侧拼装 |
| 字体 | 本地化；中日韩字体分片懒加载 |
| 缩略图 | 保存后在空闲时用 `exportToBlob`（最长边 512）生成，Rust 写缓存，列表滚到才加载 |
| 外壳 UI | 不和画布抢主线程：虚拟列表、selector 订阅、没有常驻动画 |
| 基准 | 同一张大图（约 3000 个元素，其中约 1400 条手绘）在 ExcalidrawZ / Safari / Chrome / 新壳上对比：平移缩放帧率、手绘延迟、打开耗时、保存期间的长任务、内存 |

---

## 6. 路线图

时间按「一个人 + AI 辅助」粗估。

| 阶段 | 内容 | 产出和决策点 |
|---|---|---|
| **P0 性能实验**（2–3 天） | Tauri 空壳 + Excalidraw + 120Hz；大图基准对比四个环境；iCloud Drive 读写和 TCC 体验；无数据文件下载 | **决策门槛：** 如果新壳在大图上明显好于 ExcalidrawZ 且接近 Safari，继续；如果 WebKit 本身就是瓶颈，评估 CEF 或 Electron |
| **P1 MVP**（1–2 周） | 单工作区 + 打开任意文件 + 标签 + 保存链路 + 文件关联 + 原生菜单 + 导出 + 深色模式 | 能日常替代 ExcalidrawZ |
| **P2 iCloud 好用**（1–2 周） | 同步状态、按需下载、外部修改合并、冲突处理、历史版本 | 两台 Mac 交叉编辑不丢数据 |
| **P3 体验** | 缩略图网格、全文搜索（图里的文字）、素材库存进工作区、模板、多窗口 | — |
| **P4 拓展** | 自有 iCloud 容器 + iPad 版（Tauri iOS）、AI / MCP、Obsidian 格式、演示模式、Quick Look | 按需排 |

---

## 7. 拓展方向

- **iPad 版：** Tauri 2 支持 iOS，前端几乎原样复用，iCloud 容器共用。风险：iPad 上手绘延迟（Excalidraw #7489），iOS 的 WKWebView 同样有 60fps 限制。
- **AI / MCP：** 内置一个本地 MCP server，让 Claude 读写工作区里的图（「把这段需求画成流程图」「整理这张图的布局」）；Excalidraw 自带的「文本转图」（Mermaid）也可以接上 Claude。
- **Obsidian 互通：** 读写 `.excalidraw.md`。
- **全文搜索：** Rust 侧解析文本元素建索引，⌘K 跨文件搜图里的字。
- **演示模式：** 把 frame 当幻灯片放映。
- **Quick Look / Finder 缩略图：** Swift 写的 App 扩展（`.appex`）；需要 App Group 共享缩略图缓存，或者在扩展里自己渲染。
- **素材库同步：** 把 library 存成工作区里的 `.excalidrawlib`，跟着 iCloud 走。
- **全局快捷键：** 在任意 App 里一键新建草图，或者截图后贴进画布标注。

---

## 8. 风险与待验证

| # | 风险 | 应对 |
|---|---|---|
| 1 | WebKit 的 Canvas 在大量手绘时本身就慢于 Chromium | P0 用基准实测；架构保持与 WebView 无关，退路是 Tauri 3 的 CEF 运行时（alpha）或 Electron |
| 2 | 120Hz 依赖私有 API，系统更新可能失效 | `respondsToSelector:` 防御，失效就降级到 60fps；不上 Mac App Store |
| 3 | iCloud Drive 的 TCC 授权体验（是否反复弹框） | P0 实测；不理想就提前做 P2 自有容器 |
| 4 | 合并语义：墓碑保留期、两边同时改同一个文本元素 | 用 `reconcileElements` 写单测覆盖；同一元素两边都改，取较新一边，并在横幅里提示 |
| 5 | Excalidraw 升级可能有性能回退（#12437） | 锁版本；升级前先跑基准 |
| 6 | 签名、公证、iCloud entitlement 只在 release 构建里生效 | 尽早接 CI 打签名包，别拖到最后 |
| 7 | 单人维护的私有 API 插件（`tauri-plugin-macos-fps`）质量 | 代码很短，直接自己实现（spike 已验证可行） |

---

## 9. 原型草图

草图已经在对话里渲染（可以下载），共四屏：

1. **主窗口：** 左侧边栏（工作区 / 文件夹树 / 最近 / 收藏 / 素材库，顶部搜索）；顶部是原生标题栏和文档标签；中间是原样的 Excalidraw；画布上方是「已按元素合并 N 处 · 撤销」横幅；底部状态栏显示「已保存 12:03 · iCloud 已同步 · 348 个元素 · 120 Hz」。
2. **文件夹视图：** 面包屑 + 网格 / 列表切换 + 排序 + 新建；卡片 = 缩略图 + 名称 + 时间 + 同步状态（上传中 / 仅在 iCloud）。
3. **冲突对话框：** 只有自动合并不了时才弹；两侧缩略图 + 三个选项（合并（推荐）/ 保留本机另存副本 / 用 iCloud 版本，本机这份进历史）。
4. **首次启动：** 选工作区，可选 iCloud Drive（推荐）或本地文件夹；说明文件是标准 `.excalidraw`。

主窗口线框：

```
┌● ● ●  ▤  [系统架构] [需求草图 ·] [周会白板]  +                         ⇪ ┐
├───────────────┬──────────────────────────────────────────────────────────┤
│ 🔍 搜索…      │        [✋ ↖ □ ◇ ○ → ✎ T 🖼 ⌫]   ← Excalidraw 工具栏       │
│ 工作区        │  ┌ 「Jim 的 iPad」刚改过，已合并 12 处 · 撤销合并 ┐      │
│ ☁ iCloud      │                                                          │
│   ▸ 产品      │      ┌────────┐     ┌────────┐     ┌────────┐            │
│   ▾ 架构      │      │React外壳│ ──▶ │Tauri IPC│ ──▶ │Rust文件层│          │
│     系统架构  │      └────────┘     └────┬───┘     └────────┘            │
│     数据流 ☁↓ │                          ▼                               │
│ 📁 ~/Code/docs│                    (iCloud Drive)                        │
│ 快速访问      │                                                          │
│ 🕘 最近 ★ 收藏│  [- 100% +]                                              │
├───────────────┴──────────────────────────────────────────────────────────┤
│ ✓ 已保存 12:03   ☁ iCloud 已同步   348 个元素 · 2 张图片         120 Hz │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 参考

- WKWebView 60fps 限制：[tauri#13978](https://github.com/tauri-apps/tauri/issues/13978) · [tauri-plugin-macos-fps](https://github.com/userFRM/tauri-plugin-macos-fps)
- Tauri CEF 运行时：[tauri-runtime-cef v3.0.0-alpha.0](https://github.com/tauri-apps/tauri/releases/tag/tauri-runtime-cef-v3.0.0-alpha.0) · [crates.io](https://crates.io/crates/tauri-runtime-cef/versions)
- Tauri 打包与签名：[macOS 应用包](https://v2.tauri.app/distribute/macos-application-bundle/) · [App Store](https://v2.tauri.app/distribute/app-store/) · [#16211 sidecar 与受限 entitlement](https://github.com/tauri-apps/tauri/issues/16211) · [#15144 dev 下没有沙盒](https://github.com/tauri-apps/tauri/issues/15144)
- Tauri 文件关联：[File Associations 文档](https://v2.tauri.app/learn/mobile-file-associations/)
- Tauri IPC 二进制传输：[#9322](https://github.com/tauri-apps/tauri/issues/9322) · [讨论 #11915](https://github.com/orgs/tauri-apps/discussions/11915)
- iCloud：[Developer ID 应用使用 iCloud](https://flaviocopes.com/mac-iphone-sync/) · [Sonoma 起 iCloud Drive 改用 FileProvider 与无数据文件](https://eclecticlight.co/2023/10/25/macos-sonoma-has-changed-icloud-drive-radically/) · [Enabling iCloud Storage](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingiCloud.html)
- Excalidraw：[Releases（0.18.1）](https://github.com/excalidraw/excalidraw/releases) · [CHANGELOG](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/CHANGELOG.md) · [#12437 next 版性能回退](https://github.com/excalidraw/excalidraw/issues/12437) · [#7489 iPad 手绘延迟](https://github.com/excalidraw/excalidraw/issues/7489) · 源码 `packages/excalidraw/data/reconcile.ts`、`data/json.ts`
- 同类 Tauri 项目（可参考代码）：[bhanuka01/excalidraw-tauri](https://github.com/bhanuka01/excalidraw-tauri) · [tyrchen/excaliapp](https://github.com/tyrchen/excaliapp) · [shxntanu/excali-desktop](https://github.com/shxntanu/excali-desktop)（带 MCP 桥）
