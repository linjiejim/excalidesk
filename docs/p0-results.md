# P0 性能实验结果

2026-11-05 · MacBook Pro M1 Pro，内建 120Hz ProMotion 屏，macOS 26.2，接电源，低电量模式关闭。代码在仓库根目录。

## 结论：可以继续做 Tauri，但有一个需要正视的弱点

1. **日常编辑（缩放 ≥ 100%、手绘），Tauri 解锁 120Hz 后和 Chrome 打平，比 Safari 和 ExcalidrawZ 这一类 WKWebView 应用流畅一倍：** 120fps 对 60fps。Safari 26.2 在这台机器上也是 60fps。
2. **弱点在 WebKit 本身：** 缩到全图可见（3000 个元素同屏）时，三个 WebKit 环境平移只有 13–14fps，Chrome 是 24fps，WebKit 慢约 1.8 倍；缩放 30% 时是 53fps 对 68fps。这是 Excalidraw 在 WebKit 上的绘制开销，换外壳解决不了，Chrome 在这里也不流畅。
3. **ExcalidrawZ 式保存每次在主线程阻塞约 50ms**，平移时能看到明显的一下卡顿（最长一帧 53–61ms）。我们的保存方式最长一帧是 22.5ms。
4. **Tauri 的 IPC 不是瓶颈：** 2.7MB 正文往返 3–8ms，9.8MB 含图片全文往返 13–18ms，都包括 Rust 写盘。
5. **iCloud Drive 全部打通：** 读写、文件协调、同步状态、未下载文件的识别与按需下载都已验证（见第 3 节）。

**决策：继续做 P1。** 全图可见时卡的问题放进 P1 跟踪，有三条路：给 Excalidraw 打补丁（缩小视图时用位图缓存）、等 Tauri 3 的 CEF 运行时，或者接受现状（它在 Chrome 里也只有 24fps）。

## 1. 帧率（各环境 2 轮的中位数；p95 和 max 是帧间隔，单位 ms）

测试场景：3048 个元素，包括 1400 条手绘、40 个 frame、8 张图片，共 5.5MB。画布固定 1280×800 CSS 像素，按 2 倍像素密度渲染。交互通过 Excalidraw 真实的 wheel / pointer 事件入口注入。

| 场景 | Tauri 120Hz | Tauri 60Hz（≈ExcalidrawZ） | Safari 26.2 | Chrome 156 |
|---|---|---|---|---|
| 空闲 rAF | 119.5 fps | 60.1 fps | 59.3 fps | 120.0 fps |
| 平移 · 全图可见 | 12.9 fps · p95 108 | 13.3 fps · p95 106 | 14.5 fps · p95 102 | **24.1 fps** · p95 55 |
| 缩放 · ctrl+滚轮 | 41.3 fps | 34.1 fps | 32.4 fps | 46.0 fps |
| 平移 · 30% | 53.4 fps | 53.3 fps | 52.8 fps | 68.0 fps |
| 平移 · 100% | **120 fps** · p95 9.5 | 60 fps · p95 18 | 60 fps · p95 18 | 120 fps · p95 10.1 |
| 手绘（全图可见，画在 frame 里） | **118.8 fps** | 60.3 fps | 60.1 fps | 117.3 fps |
| 100% 平移 + 每 1.5s 保存（ours） | 119.8 fps · max 22.5 | 60.0 fps · max 22.5 | 60.2 fps · max 25.5 | 120 fps · max 10.4 |
| 100% 平移 + 每 1.5s 保存（ExcalidrawZ 式） | 117.9 fps · **max 53.5** | 59.4 fps · **max 60** | 59.3 fps · **max 61** | 117.5 fps · **max 50.6** |

说明：「Tauri 60Hz」和 ExcalidrawZ 用的是同一个引擎、同样的帧率限制，但没有它的 Swift 侧开销，所以只能当作 ExcalidrawZ 的上限参考。ExcalidrawZ 本身没法注入脚本来测，凭手感对比需要你自己并排打开同一张图（Tauri 版手动模式右下角有帧率表）。

## 2. 打开与保存（毫秒）

| 指标 | Tauri 120 | Tauri 60 | Safari | Chrome |
|---|---|---|---|---|
| 首次打开（含字体、首帧） | 861 | 918 | 898 | 745 |
| 再次打开 | 701 | 699 | 704 | 716 |
| 其中 JSON.parse + restore | 23 | 30 | 25 | 19 |
| getSceneVersion（每次 onChange 做的比对） | 0.1 | 0.1 | 0.0 | 0.1 |
| ours：按元素缓存 JSON，改 1 个元素后序列化 | 11.5 | 11.0 | 11.0 | 7.2 |
| 朴素：整份 stringify + encode | 17.0 | 17.0 | 17.5 | 13.1 |
| ExcalidrawZ 式：同步阻塞段 | 51.0 | 52.5 | 45.0 | 50.2 |
| ExcalidrawZ 式：含分片、哈希的全程 | 558 | 568 | 591 | 630 |
| Tauri IPC：2.7MB 正文往返（含写盘） | 8.0 | 3.0 | — | — |
| Tauri IPC：9.8MB 含图片全文往返 | 18.0 | 13.5 | — | — |

结论：

- **打开大约 700ms，主要花在 Excalidraw 首次生成图形缓存上**，parse 加 restore 只占 25ms 左右。各环境差别不大，壳层面没有什么可优化的。以后可以先显示缩略图来掩盖等待。
- **按元素缓存 JSON 在 WebKit 上比整份序列化快约 35%**（11ms 对 17ms），但仍然超过 120Hz 一帧的预算（8.3ms）。所以 P1 的保存链路要再进一步：**JS 只把变了的元素发给 Rust，由 Rust 维护整张图的元素表并序列化成文件**。这样 JS 侧每次保存的成本是 O(变化量)：只剩 0.1ms 的版本比对，加上几个元素的 stringify。

## 3. iCloud Drive 自检（Tauri 应用内，ad-hoc 签名，非沙盒）

| 项 | 结果 |
|---|---|
| 访问 `~/Library/Mobile Documents/com~apple~CloudDocs` | 成功（列出 6 个条目）；终端里的 shell 被 TCC 拦住，独立启动的 App 可以访问 |
| `NSFileCoordinator` 协调写（临时文件 + rename，200KB） | 31ms，成功 |
| 协调读 | 12ms，内容一致 |
| `isUbiquitousItemAtURL` | true |
| 同步状态资源值（下载状态、是否已上传、是否在上传、是否有冲突） | 全部能读到；写完立即是 Current / 未上传，**约 26 秒后变成已上传** |
| 驱逐（`evictUbiquitousItemAtURL`）后 | 立即变成无数据文件（`SF_DATALESS`），状态为 NotDownloaded，没有 `.icloud` 占位文件（FileProvider 模式） |
| 读取无数据文件 | **阻塞 5.06 秒后自动下载完成**，内容一致，无数据标记消失 |
| `NSFileVersion` 未解决冲突 | 0（接口可用） |

结论：

- **P1 的 iCloud 方案（普通文件夹 + 文件协调）可行，Rust 直接调 Foundation 就够，不需要 Swift。**
- **读取未下载的文件会阻塞好几秒，必须放在后台线程，UI 显示「正在从 iCloud 下载」。** 列表里用 `SF_DATALESS` 或资源值标出「仅在 iCloud」。
- 上传有十几到几十秒的延迟，状态栏要区分「已保存到本机」和「已同步到 iCloud」。
- 留下了测试文件夹 `iCloud Drive/Excalidraw-P0-test/`（一个 200KB 的文件），可以删掉。
- 还没验证：签名后的正式包首次访问 iCloud Drive 会不会弹 TCC 授权框（这次没留意到弹框）；两台设备同时修改时 `NSFileVersion` 冲突的真实行为（需要第二台设备）。

## 4. 对方案的修正

1. **「Safari 不受 60fps 限制」是错的：** 在这台机器上 Safari 26.2 也是 60fps。120fps 只有 Chrome 和解锁后的 Tauri 能做到。这反而是 Tauri 版的卖点：比 Safari 里的 excalidraw.com 还流畅。
2. **保存链路从「JS 序列化整份正文」改成「JS 发变化的元素，Rust 维护模型」**（见第 2 节）。
3. **新增风险：全图可见时 WebKit 比 Chromium 慢 1.8 倍。** P1 期间评估三条路：给 Excalidraw 打补丁、CEF 运行时、接受现状。

## 5. 复现

```bash
node bench/gen-scene.mjs && npm run build && npx tauri build --bundles app
```

```bash
npm run preview
```

```bash
bench/run-matrix.sh 2 && python3 -I bench/summarize.py
```

手动凭手感对比：直接打开 `src-tauri/target/release/bundle/macos/ExcalidrawP0.app`（默认 120Hz，加载测试大图，右下角显示帧率）；ExcalidrawZ 里打开 `public/scenes/large.excalidraw`。
