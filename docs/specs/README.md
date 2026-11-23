# Specs

动手之前写的方案：问题、做法、接口、决策、验收。文件名 `YYYYMMDD-<kebab-name>.md`，日期是创建那天；状态 draft → confirmed → done（或 abandoned）。

| Spec | 内容 | 状态 |
|---|---|---|
| [20261117-presentation-mode.md](20261117-presentation-mode.md) | 演示模式：frame 当幻灯片放映、演讲者备注、导出 PDF、MCP 幻灯片参数 | done（0.7.0） |
| [20261122-ios-viewer.md](20261122-ios-viewer.md) | iOS 预览 App：选文件夹看 `.excalidraw`，和桌面端一样的渲染（离线 Excalidraw → 矢量 PDF → PDFKit），原生手势和 Liquid Glass | confirmed（模拟器已验证，未合并） |
| [20261123-convert-shapes.md](20261123-convert-shapes.md) | 转换形状：文本、矩形、菱形、椭圆互转；Actions 栏按钮 + 浮层，Tab 循环，⇧R ⇧D ⇧O ⇧T | confirmed |
