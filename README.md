# Excalidesk

一个快、离线优先的 [Excalidraw](https://github.com/excalidraw/excalidraw) macOS 桌面版，基于 Tauri 2。

- **文件就是标准 `.excalidraw`**：工作区就是普通文件夹，excalidraw.com、Obsidian 插件、git 都能直接用
- **iCloud Drive 同步**：把工作区放进 iCloud Drive 即可；显示上传 / 下载状态，外部修改按元素自动合并
- **120Hz**：解除 WKWebView 默认的 60fps 限制，ProMotion 屏上平移、手绘和 Chrome 一样跟手
- **增量保存**：编辑时只把变了的元素交给 Rust，大图保存不卡主线程
- **本地历史版本**：自动留档，合并前先备份，一键恢复或另存为副本
- **边界情况都兜住**：iCloud 冲突版本自动合并；文件在外部被删除或移走时暂停保存，不会把它写回来
- 中英双语、浅色 / 深色 / 跟随系统（设置 ⌘,）
- 侧边栏：右键菜单、双击改名、拖动调整工作区顺序、按修改时间 / 创建时间 / 名称排序
- 标签页、原生菜单、双击打开、PNG / SVG 导出

> 状态：早期版本，目前只支持 macOS 13+。

## 更新

装好之后 Excalidesk 会从 GitHub Releases 自己更新：启动时和之后每隔几小时查一次最新 release，在后台下载，用 App 里内置的公钥验签，装好后提示重启（重启前先把打开的图存完）。在 设置 → 自动更新 里关掉，或用 Excalidesk → 检查更新… 立即检查。0.3.0 及更早的版本还没有这个功能，需要手动下载一次新版本。

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

### 发布

推一个 `v0.4.0` 这样的 tag：Release 工作流先建草稿 release，再分别构建 Apple 芯片和 Intel 两个架构上传进去，连同签好名的更新包和更新器读的 `latest.json`。草稿要手动发布：已安装的 App 只读最新一个**已发布** release 里的 `latest.json`，发布了才算推送更新。工作流会先核对 tag 和 `tauri.conf.json` 里的版本号一致，写 `latest.json` 之前再用公钥验一遍两个更新包。

更新包的签名需要仓库 secret `TAURI_SIGNING_PRIVATE_KEY`：本机 `~/.tauri/excalidesk/updater.key` 的内容（没有密码），公钥是 `tauri.conf.json` 里的 `plugins.updater.pubkey`。私钥要备份好：已安装的 App 只接受这把钥匙签的更新，换钥匙就得换 `pubkey`，所有人再手动下载一次。Apple 签名和公证可选，secret 名同 Retrace（`APPLE_CERTIFICATE` 等）。

`npm run release` 仍然可以在本机打 dmg，但不生成更新包，不会推给已安装的 App。

## 目录

```
src/shell/        外壳 UI 与文档会话（保存调度、增量、外部修改合并）
src/bench/        性能基准页（?bench=1）
src-tauri/src/    Rust：文档模型与原子写、工作区扫描与 FSEvents、iCloud、菜单、120Hz
bench/            基准与自测脚本、测试场景生成
docs/             方案、P0 性能实验结果、各阶段说明
```

## 设计要点

详见 [docs/plan.md](docs/plan.md)、[docs/p0-results.md](docs/p0-results.md)、[docs/p1-notes.md](docs/p1-notes.md)、[docs/p2-notes.md](docs/p2-notes.md)、[docs/v0.3-notes.md](docs/v0.3-notes.md)。

- Excalidraw 用官方 npm 包（锁定 0.18.1），不 fork。
- Web 层只管画，Rust 层掌管文件：读写走 `NSFileCoordinator`，写入是临时文件 + rename 的原子写。
- 视口、最近打开等 App 状态不写进 `.excalidraw`，避免只是滚动一下就触发 iCloud 上传。
- 已删除元素以 `isDeleted` 墓碑保留，多设备合并时不会把删掉的东西合并回来。
- 不用窗口毛玻璃：透明 WKWebView 会让画布渲染慢一倍左右（见 p2-notes）。

## 许可

MIT。Excalidraw 本身同为 MIT 许可。
