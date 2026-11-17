# 演示模式：frame 当幻灯片放映、导出 PDF

- 日期：2026-11-17
- 状态：confirmed（Jim 2026-11-17：页面横排，其余按建议；V1 含导出 PDF；演讲者备注放在页下方的特殊 frame 里；写完直接开工）
- 依赖：Agent 协作（MCP，[docs/mcp.md](../mcp.md)）、`@excalidraw/excalidraw` 0.18.1
- 范围：前端放映、新建页 / 备注、导出 PDF；MCP 的 `draw` / `draw_mermaid` / `update_elements` / `read_drawing` 补幻灯片相关的参数和输出；原生菜单加「演示」
- 不碰：`.excalidraw` 文件格式（只在 `customData.excalidesk` 里加字段）、保存链路、历史、iCloud、Windows / Linux

## 背景和目标

Agent 直接在画布上画、用户自己改，用一个固定宽高的 frame 框住「一页」，演示时一页一页翻。Excalidraw 自带 frame（会裁掉超出部分）、只读模式、隐藏 frame 名字和边框、激光笔；Excalidesk 的 Agent 本来就按「一个方案一个 frame」来画。所以演示模式只是给 frame 多一种用法，不用新建一种文档。

## 设计

### 页面、顺序和备注（数据约定）

- **页面** = 图里每一个没删掉的 `frame` / `magicframe`，**备注 frame 除外**。
- **固定尺寸页**：`customData.excalidesk.slide = true`。「新建一页」和 MCP 的 `slide: true` 建出来的 frame 带这个标记，默认 1920×1080。它只影响 Agent 工具：往里加内容时**不撑大**，超出的部分报告给 Agent。放映时所有页一视同仁，比例不对的留黑边。
- **备注 frame**：带 `customData.excalidesk.notesFor = <页的 id>`，或者名字以「备注」「Notes」开头（不分大小写，给手画的用）。（D16 收紧：名字得是整个词；固定页永远是页）
  - 归属：**正上方那一页优先**（备注 frame 的水平中线落在页的左右范围内、页在它上面、离得最近的一页）；正上方没有页时，才用 `notesFor` 里的 id。一页有多个备注 frame 就从上到下拼起来。没归属的备注 frame 不放映，也不算页。
  - 备注内容：这个 frame 里所有文字元素（含形状里的标签），按 y、x 排序，用空行连起来。
- **顺序：先行后列**。页按顶边排序；一页的垂直中线落在当前行的上下范围内就归进这一行，否则开新的一行；行内从左到右。默认布局是一行横排：页宽 1920、页间距 160；备注 frame 在页下方 80，和页同宽，高 480。
- 前端（`src/shell/slides.ts`）和 Rust（`src-tauri/src/mcp/scene.rs`）各实现一份排序和配对，用同一组用例测试（D12）。

```ts
// src/shell/slides.ts
export const SLIDE_W = 1920, SLIDE_H = 1080, SLIDE_GAP = 160, NOTES_GAP = 80, NOTES_H = 480;
export type Slide = { frame: El; notes: El[]; notesText: string };
export function slidesOf(elements: readonly El[]): Slide[];   // 按放映顺序
export function isNotesFrame(e: El): boolean;
export function nextSlideBox(elements: readonly El[]): Box;    // 新页放哪
```

### 新建页、添加备注（用户）

- 菜单「演示 → 新建一页」（⌥⌘N）：1920×1080，名字「第 n 页」/「Slide n」，带 `slide` 标记。放在最后一行最后一页的右边（间距 160，顶边对齐）；还没有页就放在现有内容右边；画布是空的就放在原点。建好后选中它，镜头对准它。可以撤销。
- 「演示 → 添加演讲者备注」：给选中的页（没选就用视口中心那页）在下方建备注 frame，里面放一段占位文字「演讲者备注」，并选中这段文字。已经有备注就直接选中它，镜头移过去。

### 放映

- 入口：「演示 → 从当前页开始」（⌥⌘P）、「演示 → 从第一页开始」（⇧⌥⌘P），Excalidraw 左上角菜单里也加「演示」。当前页 = 选中的页 → 视口中心所在的页 → 第一页。一页都没有就提示怎么建。
- 进入时：
  - 窗口全屏（本来就是全屏的不动，退出时恢复原样）；外壳的侧栏、标签栏、状态栏、横幅、Agent 条、批注输入框、历史面板都隐藏，画布铺满。
  - Excalidraw：`viewModeEnabled`、`zenModeEnabled`；`frameRendering = { enabled: true, clip: true, name: false, outline: false }`；清空选择；用 CSS 藏掉 Excalidraw 自己的界面层；主题强制浅色（D6）。
  - 记下进入前的镜头、工具、选择、上面这几项 appState，退出时原样恢复（D9）。
- **镜头自己算**：Excalidraw 的 `scrollToContent` 会把缩放向下取整到 0.1 一档，1920 宽的页在 1512 宽的屏上只能占 89%。所以缩放取 `min(屏宽/页宽, 屏高/页高)` 的精确值，用 `updateScene` 直接设 `zoom` / `scrollX` / `scrollY`；翻页时自己做补间（约 350ms，缓动，缩放按对数插值）。
- **遮罩**：一个和当前页屏幕位置重合的透明框，`box-shadow` 把框外全部涂黑，`pointer-events: none`。跟着 `api.onScrollChange` 和窗口尺寸变化更新，所以相邻页永远露不出来。
- 按键（在 window 捕获阶段拦截，Excalidraw 收不到）：

  | 键 | 作用 |
  |---|---|
  | → ↓ 空格 PageDown 回车 | 下一页 |
  | ← ↑ ⇧空格 PageUp ⌫ | 上一页 |
  | Home / End | 第一页 / 最后一页 |
  | K | 开关激光笔（只读模式下 Excalidraw 自己屏蔽了 K，这里调 `setActiveTool`） |
  | N | 开关当前页的备注（叠在画面底部，排练用） |
  | Esc | 退出 |

- 滚轮和触控板缩放在放映中屏蔽；指针不拦（激光笔、点链接要用）。拖动挪走了镜头，下次翻页回正。窗口尺寸变了就无动画地重新对准。
- 换页时右下角显示「3 / 12」，1.5 秒后淡出。
- 放映中 Agent 改了图：画布本来就是活的，当前页直接变。每次翻页都按当前页的 id 重新算顺序，页被删了就停在原位置附近。
- 放映中的图被关掉、或者切到别的标签：退出放映。

### 导出 PDF

- 「文件 → 导出 PDF…」，Excalidraw 左上角菜单也加一项。存储对话框默认 `<图名>.pdf`。
- 一页一张 PDF 页，顺序同放映。PDF 页尺寸 = frame 的宽高（单位 pt，和 Keynote 一样）。图里没有页就把整张图导成一页。
- 每页用 `exportToCanvas`（`exportingFrame` = 这一页，背景色同画布，浅色，不导批注），按 2 倍渲染、长边不超过 3840 像素。
- 编码：这一页有图片元素就用 JPEG（质量 0.9，`DCTDecode`）；否则取 RGB 像素，用 `CompressionStream("deflate")` 压成 `FlateDecode`，无损（D7）。
- `src/shell/pdf.ts`：自己写最小的 PDF（Catalog、Pages、每页一个 Page + 内容流 + 图片 XObject、xref、Info 里写标题），不加依赖。
- 导出时提示进度「正在导出 PDF（3/12）…」。备注、批注不进 PDF；PDF 里的文字不能选、链接不能点（V1 不做）。

### MCP

- `draw` 新参数：
  - `slide: bool`：画在一页幻灯片上。`frame` 是已有的 frame 就画进去，否则新建一页固定尺寸的页（名字取 `frame`，没给就是「Slide n」），按上面的规则排在最后一页右边。元素坐标是**页内坐标**：(0,0) 是页的左上角，页是 1920×1080。和 `at` 一起用会报错。
  - `notes: string`：这一页的演讲者备注。没有备注 frame 就在页下方建一个；有就替换里面的文字。只能和 `slide` 一起用。
  - 返回值加 `slide`（页的 id）、`notes`（备注文字元素的 id）、`overflow`（超出页边界的元素 id 和提示：放映时会被裁掉，挪进来或缩小）。
- 固定尺寸页（带 `slide` 标记）**不再被撑大**，不管是哪个工具往里加的：`draw` 不带 `slide`、`draw_mermaid` 加进固定页时，同样用页内坐标 / 放在页里已有内容的下方，超出的报告在 `overflow`。普通 frame 还是老样子（撑大）。
- `draw_mermaid` 也加 `slide: bool`：新建或加进一页，图在页内水平居中，放在页里已有内容的下方。
- `update_elements` 挪动一页时，它的备注 frame（连同里面的东西）跟着挪。
- `read_drawing` 输出加 `slides`：`[{ id, name, x, y, w, h, fixed?, notes?: "文字", notesFrame?: id }]`，按放映顺序；`frames` 里的备注 frame 标上 `notesFor`。
- 服务端说明（`INSTRUCTIONS`）加一段：做演示文稿时一页调一次 `draw`（`slide: true`、`style: "clean"`），页内坐标 1920×1080，正文字号不小于 32、标题 64 以上，用 `notes` 写演讲者备注，画完逐页 `render_drawing` 检查；用户用 ⌥⌘P 放映，页面从左到右播放。

### 菜单

- 新增顶层菜单「演示 / Present」：从当前页开始 ⌥⌘P、从第一页开始 ⇧⌥⌘P、—、新建一页 ⌥⌘N、添加演讲者备注。
- 「文件」里「导出 SVG…」下面加「导出 PDF…」。

## 验收

1. 图里有两页并排、第二行一页，第一页下方有备注 frame：放映顺序是「左、右、第二行」，备注 frame 不在其中。⌥⌘P 从选中的页开始；→ ← 空格 PageUp Home End 都能翻；Esc 退出后，镜头、工具、选择、只读 / 禅模式、frame 显示方式、窗口是否全屏都和进入前一样，文件没有因为放映被标脏。
2. 放映中只看得到当前页：相邻页被遮住，frame 名字和边框不显示，外壳和 Excalidraw 的界面都不见了；页铺满屏幕的一个方向（不是 0.1 一档的缩放）；K 能用激光笔；N 显示当前页备注。
3. 「新建一页」在最后一页右边 160 处建一个 1920×1080 的页，⌘Z 能撤销；「添加演讲者备注」在选中页下方建备注 frame。
4. 导出 PDF：n 页的图得到 n 页 PDF，顺序和放映一致，每页比例等于 frame 比例、内容被 frame 裁剪、没有批注和备注，用「预览」能打开；没有 frame 的图导出一页整图。
5. MCP：连续两次 `draw` + `slide: true` 得到两个从左到右、间距 160 的 1920×1080 固定页；元素超出页边时 `overflow` 列出它们、页没有变大；`notes` 建出备注 frame，再调一次是替换文字；`read_drawing` 的 `slides` 顺序正确、带备注文字；`update_elements` 挪页时备注跟着走。
6. `npm run typecheck`、`cargo test --lib mcp`（含新的排序 / 配对用例）、`bench/mcp-e2e.py`（含新步骤）、老的 `--selftest` 全过。

## 决策

- **D1 一页就是一个 frame，不加新格式。** 文件照样能在 excalidraw.com、Obsidian、git 里用。不选：新的「幻灯片」元素类型，或只有打了标记的 frame 才算页（多一步操作，Agent 画的方案图也就不能直接放映了）。
- **D2 横排，先行后列。** Jim 定的。Agent 的 `draw` 本来就把新 frame 放在现有内容右边，正好一致。不选：竖排。
- **D3 「固定宽高」= 默认 1920×1080 + `slide` 标记，不锁比例。** 标记只让 Agent 工具不撑大、报溢出；用户手动改了比例，放映时留黑边。不选：锁定比例（Excalidraw 的 frame 没有这个能力，要在 onChange 里纠正，和用户手感打架）。
- **D4 备注 = 页下方的特殊 frame（Jim 定的）；归属先看几何，再看 id。** 选中页和备注一起复制时，`customData` 原样复制，`notesFor` 还指着原来那页；看几何（正上方那页）就不会错。只挪了页、没挪备注时，正上方没有页了，就退回用 id。不选：只看 id（复制会错）；只看名字（改个名就丢了）。
- **D5 放映用活画布 + 自己算镜头 + 遮罩，不用导出成图片再放。** 好处是激光笔、链接、Agent 改了马上能看到、翻页有动画。不选：每页先渲染成图片再全屏放（简单，但上面这些都没了）。
- **D6 放映强制浅色主题。** 和 PDF 一致；深色模式下 Excalidraw 是整体反色，幻灯片会变样。不选：跟随 App 主题。
- **D7 PDF 用栅格页（2 倍），无图片的页无损压缩，有图片的页用 JPEG；自己写最小 PDF，不加依赖。** 不选：jsPDF + svg2pdf.js（要加依赖，而且不支持 Excalidraw SVG 里内嵌的 web 字体，文字会走样）；WKWebView 打印成 PDF（分页和页尺寸难控制，要写一堆 objc）。代价：文字不能选，文件比矢量的大。
- **D8 放映时批注便签照常显示，PDF 里去掉。** Excalidraw 没有「只是不显示」的办法，要藏就得改场景，改场景会被保存。演示前请先处理掉批注。
- **D9 退出放映恢复进入前的镜头。** 第一轮答复里说定的。
- **D10 V1 不做副屏的演讲者视图；用 N 在放映画面上叠备注**，排练和单屏时用。
- **D11 放映中屏蔽滚轮和缩放手势，不拦指针。** 激光笔和链接都靠指针。拖动挪走了，翻页时回正。
- **D12 排序和配对在 Rust 和 TS 各写一份，用同一组用例测。** `read_drawing` 在图没打开时也要能读，不能去问前端。不选：只在前端算、Rust 转发（图没打开就读不了）。
- **D13（实现中补充）开激光笔时临时退出只读模式。** Excalidraw 0.18.1 只读模式下按下指针一律先当成拖动画布（`handleCanvasPanUsingWheelOrSpaceDrag` 在激光笔判断之前），激光笔根本画不出来。退出只读后：界面层照样藏着；键盘在 window 捕获阶段全部拦下（⌘ 组合键只 stopPropagation、不 preventDefault，菜单快捷键照常）；粘贴、剪切、拖放、右键也拦下；激光笔工具下双击不建文字。关掉激光笔就回到只读模式。不选：一直在编辑模式里放映（每个能改图的入口都得拦，风险大）。
- **D14（实现中补充）遮罩按刚设下去的镜头画，不读 `getAppState`。** `updateScene` 之后要等 React 提交状态才变，读出来的是上一帧，翻页时遮罩会比画面快一帧、边缘抖。补间中只用自己算的镜头；用户拖动后用 `onScrollChange` 传进来的值。
- **D16（审查后补充，修订 D4 的识别规则）固定页永远是页；按名字认备注只认整个词。** 原来名字以「Notes」开头就算备注，Agent 建一页叫「Notes & references」的固定页，它会从放映、`read_drawing` 和 PDF 里一起消失；用户的「Notes app redesign」也一样。现在：带 `slide` 标记的 frame 不会是备注；名字得是「备注」「Notes」这个词本身，后面没别的或跟着分隔符（`· : ： - — – ( （ | /`），比如「备注 · 第二页」「notes: intro」。TS 和 Rust 同一条规则、同一组用例。
- **D15（实现中补充）新页的位置跳过伸进那一带的其他内容。** 「最后一页右边 160」时，如果上一页有元素伸出页外，新页会接在伸出部分的右边再空 160，免得压在上面。

## 实现清单

- [x] `src/shell/slides.ts`：排序、备注识别和配对、新页位置、建页 / 建备注
- [x] `src/shell/present.ts` + Shell / Editor：进入 / 退出、镜头补间、遮罩、按键、页码、备注叠层、全屏
- [x] `src/shell/pdf.ts` + `exportPdf`：渲染、编码、写 PDF、进度
- [x] 菜单（`menu.rs`）、Excalidraw 左上角菜单、i18n；`capabilities/default.json` 加 `core:window:allow-set-fullscreen`
- [x] MCP：`draw` / `draw_mermaid` 的 `slide` / `notes`，固定页不撑大 + `overflow`，`update_elements` 带着备注挪，`read_drawing` 的 `slides`，`INSTRUCTIONS`
- [x] Rust `scene.rs` 排序 / 配对 + 单元测试；`bench/mcp-e2e.py` 加步骤；`selftest.ts` 加放映、新建页 / 备注、PDF 三步
- [x] 浏览器预览里验放映、新建页、导出 PDF；typecheck、cargo test、e2e、selftest
- [x] 更新 [docs/mcp.md](../mcp.md)、README

## 落地记录

**2026-11-17：已实现，本地验证通过，还没提交。**（这一级只到「本地验证过」，没提交、没合并、没发版）

验证实际跑了：

- `npm run typecheck` 通过。
- `cargo test --lib mcp`：12 个全过（新增放映顺序、备注按几何 / id 配对、固定页标记 3 个）。
- `bench/mcp-e2e.py`（真 App + 真 `--mcp`）：55 / 55，其中幻灯片 12 步：固定页尺寸和标记、第二页位置、`overflow` 且页不撑大、建备注、替换备注、`notes` 不带 `slide` 报错、`draw_mermaid` 进页、`read_drawing` 的顺序和备注、`notesFor`、挪页带着备注、单页渲染、Agent 的这些改动不算用户改动。
- `bench/selftest.sh`（真 App、WKWebView）：25 / 25，新增 3 步：放映（顺序 A→B→C、frame 名字和边框隐藏、页正好铺满（比例 1.000）、真的进了全屏、Esc 后镜头 / 只读 / 禅模式 / frame 显示方式恢复、全屏退出、文件没被标脏）；新建一页 + 添加备注；导出 PDF（4 页、xref 正确、页尺寸 1920×1080、写盘）。导出的 PDF 用 PDFKit 和 `sips` 打开：4 页、标题「演示」、内容正确。
- 浏览器预览（Chromium）：放映截图（铺满、黑边、无界面）、翻页、N 看备注、K 激光笔（画出红色轨迹、画布没被拖动、没改图）、补间时镜头连续变化、PDF 在 Chromium 的 PDF 查看器里两页（一页无损、一页有图片走 JPEG）、左上角菜单四项、新建一页 / 添加备注 / ⌘Z 撤销。

和方案的出入：D13、D14、D15（见上）。

没做 / 没验：

- 真 App 里没有人眼看过放映的动画手感和激光笔（selftest 只验了状态；激光笔是在 Chromium 里看的）。翻页动画在 WebKit 上是否卡，要在真机上看一眼。
- 原生菜单「演示」的快捷键（⌥⌘P、⇧⌥⌘P、⌥⌘N）没有在真 App 里按过，只验了菜单 id 走到的函数。
