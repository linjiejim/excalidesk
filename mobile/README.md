# Excalidesk for iPhone

只读的 `.excalidraw` 预览 App，以 iOS 为主（Expo SDK 58，iOS 17+，iOS 26 上是 Liquid Glass）。

- 选一个文件夹（iCloud 云盘或「我的 iPhone」里的）就能看里面所有的图，子文件夹也算；也可以在「文件」App 里点 `.excalidraw` →「用 Excalidesk 打开」（原地打开，不复制）
- 和桌面端一模一样的渲染：同一版本的 Excalidraw（0.18.1）离线导出矢量 PDF，手绘线条、Excalifont、中文手写字体（Xiaolai）、曲线箭头、图片都在
- 原生手势：双指缩放、惯性滚动、回弹、双击放大 / 再双击回到全图、两指单击缩小、单击隐藏工具栏
- 有 frame 的图可以「按页查看」：左右滑翻页，底部工具栏翻页、看演讲者备注
- 最近 / 文件夹 / 搜索（文件名 + 图里的文字）三个原生 Tab；深浅色画布跟随系统，也可以单独切
- 分享原文件或导出 PDF

## 怎么做的

```
.excalidraw ──读（安全作用域书签 + NSFileCoordinator，iCloud 文件按需下载）──┐
                                                                            ▼
             看不见的 WKWebView（excalidesk-renderer:// 协议，字体都在包里，完全离线）
             renderer/main.ts：restore → exportToSvg（和桌面端同一份 Excalidraw、同一份 slideOrder.ts）
                                                                            ▼
             WKWebView.createPDF → 矢量 PDF + 缩略图 PNG，按「文件 + 修改时间 + 大小」缓存在 Caches/Renders
                                                                            ▼
             PDFKit 的 PDFView 显示（原生缩放 / 滚动），上面叠双击、两指单击、单击的手势
```

- `modules/excalidesk-native/ios/`：Swift 原生模块
  - `Locations.swift`：文件夹书签、递归扫描、iCloud 占位文件、协调读取、文件夹选择器
  - `SceneRenderer.swift`：渲染队列（打开中的图优先，缩略图和搜索索引在后台排队）、磁盘缓存、自定义协议
  - `DrawingView.swift`：PDFKit 画布和手势
- `renderer/`：跑在 WKWebView 里的那一页（Vite 打包，产物进原生模块的 resource bundle，不进 git）
- `src/app/`：Expo Router 页面。`(tabs)` 是原生 Tab（最近、文件夹、搜索），`viewer` 是预览，`notes` 是备注半屏表单

深色画布不用 CSS 滤镜（PDF 里滤镜会变成位图），而是把 Excalidraw 深色模式的滤镜（invert 93% + hue-rotate 180°）直接换算到每个颜色上，图片不反色，和 Excalidraw 一致。

## 开发

需要 macOS + Xcode 26。

```bash
npm ci                      # 仓库根目录：渲染器用根目录的 Excalidraw 和 Vite
cd mobile && npm install
npm run build:renderer      # 打包渲染器 + 拷字体（约 21 MB，其中中文字体 12 MB）
LANG=en_US.UTF-8 npx expo prebuild --platform ios   # 本机 CocoaPods 需要 UTF-8 locale
npx expo run:ios            # 或用 Xcode 打开 ios/Excalidesk.xcworkspace
```

改了 `renderer/` 或 Swift 要重新构建原生；只改 `src/` 的话热更新就行。渲染结果的格式变了，把 `SceneRenderer.version` 加一，旧缓存自动作废。

```bash
npm run typecheck && npm run lint
```
