# Excalidesk

一个快、离线优先的 [Excalidraw](https://github.com/excalidraw/excalidraw) macOS 桌面版，基于 Tauri 2。

- **文件就是标准 `.excalidraw`**：工作区就是普通文件夹，excalidraw.com、Obsidian 插件、git 都能直接用
- **iCloud Drive 同步**：把工作区放进 iCloud Drive 即可；显示上传 / 下载状态，外部修改按元素自动合并
- **120Hz**：解除 WKWebView 默认的 60fps 限制，ProMotion 屏上平移、手绘和 Chrome 一样跟手
- **增量保存**：编辑时只把变了的元素交给 Rust，大图保存不卡主线程
- **本地历史版本**：自动留档，合并前先备份，一键恢复或另存为副本
- **边界情况都兜住**：iCloud 冲突版本自动合并；文件在外部被删除或移走时暂停保存，不会把它写回来
- 标签页、侧边栏右键菜单与行内重命名、原生菜单、双击打开、PNG / SVG 导出、深浅色跟随系统

> 状态：早期版本，目前只支持 macOS 13+。

## 开发

需要 Node 20+、Rust（stable）、Xcode Command Line Tools。

```bash
npm install
npm run tauri dev        # 开发模式
npm run app              # 打包 .app → src-tauri/target/release/bundle/macos/
npm run selftest         # 构建并在真 App 里跑端到端自测
npm run release          # 打发布包（不带测试场景）→ release/Excalidesk_<版本>_<架构>.dmg
npm run dev              # 只在浏览器里看界面（用假数据，不需要 Tauri）
```

## 目录

```
src/shell/        外壳 UI 与文档会话（保存调度、增量、外部修改合并）
src/bench/        性能基准页（?bench=1）
src-tauri/src/    Rust：文档模型与原子写、工作区扫描与 FSEvents、iCloud、菜单、120Hz
bench/            基准与自测脚本、测试场景生成
docs/             方案、P0 性能实验结果、各阶段说明
```

## 设计要点

详见 [docs/plan.md](docs/plan.md)、[docs/p0-results.md](docs/p0-results.md)、[docs/p1-notes.md](docs/p1-notes.md)、[docs/p2-notes.md](docs/p2-notes.md)。

- Excalidraw 用官方 npm 包（锁定 0.18.1），不 fork。
- Web 层只管画，Rust 层掌管文件：读写走 `NSFileCoordinator`，写入是临时文件 + rename 的原子写。
- 视口、最近打开等 App 状态不写进 `.excalidraw`，避免只是滚动一下就触发 iCloud 上传。
- 已删除元素以 `isDeleted` 墓碑保留，多设备合并时不会把删掉的东西合并回来。
- 不用窗口毛玻璃：透明 WKWebView 会让画布渲染慢一倍左右（见 p2-notes）。

## 许可

MIT。Excalidraw 本身同为 MIT 许可。
