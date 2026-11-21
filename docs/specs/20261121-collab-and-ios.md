# 分享链接、多人实时协作（自部署）与 Expo iOS 预览 App

- 日期：2026-11-21
- 状态：done
- 范围：
  1. 开源可自部署中继与加密快照服务端（`server/` + `docker-compose.yml`）
  2. 端到端加密协作协议、客户端与移动端友好的独立 Web 端（`src/collab/`、`src/web/`）
  3. Excalidesk 桌面外壳集成（`src/shell/collab.ts`、标签栏分享入口、设置页服务器配置、菜单）
  4. 基于 Expo 的 iOS 移动端预览 App（`mobile/`，原生 Swift iCloud 模块 + Expo Config Plugin + 离线画布与幻灯片预览 + 协作链接预览）

## 架构要点

- **端到端加密（AES-GCM-128）**：密钥仅放在 URL `#` 片段中（`#room=<id>,<key>` / `#share=<id>,<key>`），服务端只保存和转发密文。
- **增量同步与本地真相**：实时协作按 `(version, versionNonce)` 增量广播；收到的远端元素走 Excalidraw 的 `reconcileElements` 合并进当前 `DocSession`，自动触发防抖落盘回本地 `.excalidraw` / iCloud Drive。图片按 `fileId` 去重加密上传与按需拉取。
- **单容器自部署**：`server/` 同时承载 WebSocket `/ws`、加密快照 API `/api/*` 与构建好的静态 Web 前端 `dist/`，`docker compose up -d` 一步可用。
- **移动端预览优先**：Expo iOS App 以阅读为核心（原生 SVG 缩略图、文件名与图内文字搜索、全屏手势缩放/平移、自动识别 Excalidesk 幻灯片与演讲者备注、原生 Swift `ICloudFilesModule` 支持 iCloud 文件夹书签与 `NSFileCoordinator` 按需下载，在 Expo Go 下平滑降级为系统文档选择器）。

## 验证

- `npm run typecheck`、`npm run build`（Web 前端 + 桌面外壳）通过
- `npm run server:test`（HTTP API、路径穿越拦截、多客户端 WebSocket 中继、只读权限拦截）：6 / 6 通过
- `npm run test:collab`（AES-GCM 加解密、URL 解析、真实服务端快照与双客户端实时同步 + 图片 + 光标）：4 / 4 通过
- `mobile/`：`npm run typecheck`、`npm test`（6 / 6）、`npx expo config --type introspect`（iCloud entitlements + `.excalidraw` UTI）、`npx expo export --platform ios`（Metro Hermes 打包）全部通过
