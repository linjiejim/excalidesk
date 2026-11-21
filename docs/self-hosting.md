# 分享链接、实时协作与自部署指南

Excalidesk 的分享与多人实时协作功能完全开源（MIT），采用**端到端加密（E2EE）**，支持一键自部署。

## 安全模型（零知识中继）

- 所有画布元素、图片附件、实时光标与昵称在离开设备前均使用 **Web Crypto AES-GCM-128** 加密。
- 解密密钥只保留在 URL 的 `#` 片段里（`#room=<id>,<key>` 或 `#share=<id>,<key>`），浏览器不会把 `#` 片段发给服务端。
- 自部署服务端只中继和持久化密文，无法看到任何画布内容。

## 方式一：Docker Compose（推荐）

在仓库根目录执行：

```bash
docker compose up -d
```

服务默认监听 `http://localhost:3456`，同时提供：

- WebSocket 实时协作中继：`/ws`
- 加密快照与图片存储 API：`/api/shares`、`/api/rooms/:id/...`
- 健康检查：`GET /api/health`
- 独立 Web 预览 / 协作前端：打开分享或协作链接即可直接在桌面或手机浏览器访问

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `EXCALIDESK_PORT` / `PORT` | `3456` | 监听端口 |
| `DATA_DIR` | `/data`（本地为 `./data`） | 加密快照与图片文件存储目录 |
| `SHARE_TTL_DAYS` | `30` | 自动清理超过 N 天未更新的快照与房间（`0` 关闭清理） |
| `MAX_BODY_MB` | `25` | 单个加密快照 / 图片体积上限（MB） |
| `CORS_ORIGIN` | `*` | 允许跨域访问的来源 |

## 方式二：直接用 Node.js 运行（Node 22+）

```bash
npm install
npm run build                        # 构建静态 Web 端 → dist/
npm --prefix server install
npm run server:build
PORT=3456 DATA_DIR=./server/data npm run server:start
```

## 反向代理（HTTPS + WebSocket）

生产环境请配置 HTTPS（Web Crypto API 在非 `localhost` 域名下需要安全上下文）：

### Caddy

```caddyfile
draw.example.com {
    reverse_proxy 127.0.0.1:3456
}
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name draw.example.com;

    client_max_body_size 25M;

    location /ws {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 在 Excalidesk 桌面端使用

1. 打开 **设置（⌘,）→ 协作服务器地址**，填入你的地址（例如 `https://draw.example.com` 或 `http://localhost:3456`），点「测试连接」。
2. 点标签栏右侧的 **分享与协作** 图标（或 ⇧⌘L）：
   - **开启实时协作**：生成 `#room=...` 链接，协作者在浏览器打开即可实时一起画，改动会自动 `reconcileElements` 并存回你的本地 `.excalidraw` 文件。也支持复制只读链接（`&ro=1`）。
   - **生成只读链接**：把当前画布端到端加密上传，生成 `#share=...` 静态链接，本机离线也能打开。

## iOS App（Expo，预览 iCloud 中的 `.excalidraw`）

移动端代码位于 `mobile/`，优先面向移动端阅读体验（双指缩放、拖拽、深浅色、幻灯片分页与演讲者备注、全文搜索、分享与实时协作链接预览）。

### 快速预览（Expo Go）

```bash
cd mobile
npm install
npm start
```

在 Expo Go 中可通过「从 iCloud 打开文件」逐个打开 iCloud Drive 里的 `.excalidraw`，也可以直接浏览内置示例与协作链接。

### 完整 iCloud 文件夹持久访问（原生开发版 / EAS Build）

`mobile/plugins/withICloudExcalidraw.js` 与 `mobile/modules/icloud-files/`（Swift）提供了原生 iCloud Drive 能力：

- 安全作用域文件夹书签（连接一次 `iCloud Drive/Excalidraw`，持久记住并递归扫描子目录）
- `NSFileCoordinator` 协调读取与未下载（云端）文件按需下载
- iOS 系统「文件」App 中直接点按 `.excalidraw` 选择「用 Excalidesk 打开」

在 macOS + Xcode 上构建原生开发版：

```bash
cd mobile
npx expo prebuild --platform ios
npx expo run:ios --device
```

或使用 EAS Build（需 Apple Developer 账号并确认 `mobile/app.json` 中的 `bundleIdentifier` 与 `containerId`）：

```bash
cd mobile
npx eas build --platform ios --profile development
```
