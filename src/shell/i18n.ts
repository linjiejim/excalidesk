// 中英双语。界面文案都从这里取；Rust 返回的错误是 `err.xxx[:参数]` 形式的键，由 tErr 翻译。
import { getState, useShell } from "./store";

export type Lang = "zh" | "en";

const zh = {
  // 通用
  "app.close": "关闭", "app.cancel": "取消", "app.retry": "重试", "app.untitled": "未命名", "app.copySuffix": "副本", "app.newFolder": "新建文件夹",
  // 侧边栏
  "side.workspaces": "工作区", "side.addFolder": "添加文件夹", "side.addFolderHint": "添加文件夹（⇧⌘O）", "side.hide": "隐藏侧边栏（⌘\\）", "side.show": "显示侧边栏（⌘\\）",
  "side.empty": "还没有工作区。添加一个文件夹，里面的 .excalidraw 都会列在这里。", "side.otherRecent": "其他最近打开", "side.noDrawings": "还没有图", "side.loading": "读取中…",
  "side.newHere": "在这里新建图", "side.cloudOnly": "仅在 iCloud，打开时下载", "side.sort": "排序", "side.settings": "设置（⌘,）", "side.dragHint": "拖动调整顺序",
  // 右键菜单
  "menu.open": "打开", "menu.newDrawing": "新建图", "menu.newFolder": "新建文件夹", "menu.rename": "重命名…", "menu.duplicate": "创建副本", "menu.history": "历史版本…",
  "menu.reveal": "在 Finder 中显示", "menu.copyPath": "拷贝路径", "menu.trash": "移到废纸篓", "menu.closeAndTrash": "关闭并移到废纸篓", "menu.removeRoot": "从侧边栏移除",
  "menu.removeRecent": "从最近打开中移除", "menu.close": "关闭", "menu.closeOthers": "关闭其他标签页",
  // 排序
  "sort.mtime": "修改时间（最新在上）", "sort.ctime": "创建时间（最新在上）", "sort.name": "名称（A → Z）",
  // 标签 / 状态栏
  "tab.new": "新建图（⌘N）", "tab.close": "关闭（⌘W）",
  "status.loading": "正在打开…", "status.downloading": "正在从 iCloud 下载…", "status.error": "打不开", "status.missing": "文件已不在原位置，自动保存已暂停",
  "status.saved": "已保存 {time}", "status.opened": "已打开", "status.dirty": "有未保存的修改", "status.saving": "保存中…", "status.saveError": "保存失败：{error}",
  "status.elements": "{n} 个元素", "status.history": "历史版本",
  "sync.conflict": "iCloud 有冲突版本，正在合并", "sync.uploading": "正在上传到 iCloud", "sync.uploaded": "iCloud 已同步", "sync.waiting": "等待上传到 iCloud",
  // 编辑区
  "editor.missing": "「{title}」已在外部被删除或移走", "editor.restoreAtPath": "存回原位置", "editor.saveAs": "另存为…", "editor.cantOpen": "打不开「{title}」",
  "editor.slow": "还在打开… 如果文件在 iCloud 里还没下载到这台 Mac，可能要等一会儿。", "editor.closeTab": "关闭标签",
  // 历史
  "history.title": "历史版本", "history.desc": "编辑时每 5 分钟留一份，合并外部修改、恢复之前也会先留一份。只存在这台 Mac 上。",
  "history.empty": "还没有历史版本。编辑并保存后会自动生成。", "history.restore": "恢复", "history.copy": "副本", "history.copyHint": "另存为同目录下的新文件",
  "history.today": "今天 {hm}", "history.yesterday": "昨天 {hm}", "history.date": "{m}月{d}日 {hm}", "history.elements": "{reason} · {n} 个元素", "history.copyName": "{name}（历史 {stamp}）",
  "reason.auto": "自动", "reason.before_external": "外部修改前", "reason.before_conflict": "合并冲突前", "reason.before_restore": "恢复前",
  // 欢迎页
  "welcome.where": "图存在哪", "welcome.desc": "文件就是标准 .excalidraw，excalidraw.com、Obsidian 插件都能直接打开。",
  "welcome.icloudDesc": "在 iCloud Drive 里建一个「Excalidraw」文件夹，在你的 Mac 之间自动同步。", "welcome.local": "本地文件夹",
  "welcome.localDesc": "选任意文件夹，适合放进 git 仓库或其他同步盘。", "welcome.later": "之后还可以在侧边栏添加更多文件夹。",
  "welcome.new": "新建图", "welcome.open": "打开…", "welcome.recent": "最近打开",
  // 设置
  "settings.title": "设置", "settings.appearance": "外观", "settings.language": "语言", "settings.sort": "侧边栏排序",
  "settings.system": "跟随系统", "settings.light": "浅色", "settings.dark": "深色", "settings.zh": "简体中文", "settings.en": "English",
  "settings.autoUpdate": "自动更新", "settings.autoUpdateDesc": "启动时和之后每隔几小时到 GitHub 查看新版本，装好后提示你重启。",
  "settings.version": "Excalidesk {version}", "settings.checkNow": "立即检查", "settings.checking": "检查中…",
  // 更新
  "update.downloading": "正在下载 Excalidesk {version}…", "update.ready": "Excalidesk {version} 已装好，重启后生效。", "update.restart": "重启",
  "update.latest": "Excalidesk {version} 已是最新版本", "update.failed": "没能更新 Excalidesk：{reason}", "update.installedOnly": "只有安装好的 App 才能更新",
  // 提示 / 对话框
  "toast.onlyExcalidraw": "只能打开 .excalidraw 文件", "toast.addFolderFirst": "先添加一个文件夹，新图会放在那里", "toast.mkdirFailed": "新建文件夹失败：{error}",
  "toast.created": "已创建「{name}」", "toast.duplicateFailed": "创建副本失败：{error}", "toast.trashed": "「{name}」已移到废纸篓", "toast.trashFailed": "移到废纸篓失败：{error}",
  "toast.pathCopied": "路径已拷贝", "toast.exported": "已导出 {name}", "toast.conflictFailed": "合并 iCloud 冲突版本失败：{error}", "toast.externalFailed": "读取外部修改失败：{error}",
  "toast.unsaved": "{n} 个文件没保存成功（{names}），再关一次会直接退出",
  "toast.unsavedRestart": "{n} 个文件没保存成功（{names}），再点一次「重启」会直接重启",
  "dialog.pickFolder": "选择一个放图的文件夹", "dialog.trashTitle": "移到废纸篓", "dialog.trashFolder": "把文件夹「{name}」和里面的所有内容移到废纸篓？",
  // 会话横幅
  "banner.externalN": "外部修改了 {n} 个元素", "banner.external": "文件在外部被修改", "banner.merged": "{label}，已和你未保存的修改按元素合并（⌘Z 可撤销）",
  "banner.replaced": "{label}，已载入最新版本", "banner.conflicts": "已合并 {n} 个来自{from}的冲突版本（⌘Z 可撤销）", "banner.otherDevices": "其他设备", "banner.device": "「{d}」",
  "banner.restored": "已恢复到所选历史版本（⌘Z 可撤销）",
  // Rust 错误
  "err.no_icloud": "这台 Mac 没有开启 iCloud Drive", "err.name_invalid": "名字不能为空，也不能包含 / 或 :，不能以 . 开头", "err.exists": "「{0}」已经存在",
  "err.no_parent": "没有上级目录", "err.invalid_file": "不是有效的 .excalidraw 文件：{0}", "err.not_open": "文档没有打开", "err.trash_failed": "移到废纸篓失败", "err.reorder": "工作区列表已变化，请重试",
};

const en: typeof zh = {
  "app.close": "Close", "app.cancel": "Cancel", "app.retry": "Retry", "app.untitled": "Untitled", "app.copySuffix": "copy", "app.newFolder": "New Folder",
  "side.workspaces": "Workspaces", "side.addFolder": "Add Folder", "side.addFolderHint": "Add Folder (⇧⌘O)", "side.hide": "Hide Sidebar (⌘\\)", "side.show": "Show Sidebar (⌘\\)",
  "side.empty": "No workspaces yet. Add a folder and every .excalidraw inside it shows up here.", "side.otherRecent": "Other recent files", "side.noDrawings": "No drawings yet", "side.loading": "Loading…",
  "side.newHere": "New drawing here", "side.cloudOnly": "In iCloud only — downloads when opened", "side.sort": "Sort", "side.settings": "Settings (⌘,)", "side.dragHint": "Drag to reorder",
  "menu.open": "Open", "menu.newDrawing": "New Drawing", "menu.newFolder": "New Folder", "menu.rename": "Rename…", "menu.duplicate": "Duplicate", "menu.history": "Version History…",
  "menu.reveal": "Show in Finder", "menu.copyPath": "Copy Path", "menu.trash": "Move to Trash", "menu.closeAndTrash": "Close and Move to Trash", "menu.removeRoot": "Remove from Sidebar",
  "menu.removeRecent": "Remove from Recent", "menu.close": "Close", "menu.closeOthers": "Close Other Tabs",
  "sort.mtime": "Date Modified (newest first)", "sort.ctime": "Date Created (newest first)", "sort.name": "Name (A → Z)",
  "tab.new": "New Drawing (⌘N)", "tab.close": "Close (⌘W)",
  "status.loading": "Opening…", "status.downloading": "Downloading from iCloud…", "status.error": "Can't open", "status.missing": "File was moved or deleted — autosave paused",
  "status.saved": "Saved {time}", "status.opened": "Opened", "status.dirty": "Unsaved changes", "status.saving": "Saving…", "status.saveError": "Save failed: {error}",
  "status.elements": "{n} elements", "status.history": "History",
  "sync.conflict": "iCloud conflict found, merging", "sync.uploading": "Uploading to iCloud", "sync.uploaded": "Synced to iCloud", "sync.waiting": "Waiting to upload to iCloud",
  "editor.missing": "“{title}” was deleted or moved outside the app", "editor.restoreAtPath": "Save Back Here", "editor.saveAs": "Save As…", "editor.cantOpen": "Can't open “{title}”",
  "editor.slow": "Still opening… If the file isn't downloaded from iCloud yet, this can take a moment.", "editor.closeTab": "Close Tab",
  "history.title": "Version History", "history.desc": "A version is kept every 5 minutes while you edit, and before merging outside changes or restoring. Stored on this Mac only.",
  "history.empty": "No versions yet. They appear after you edit and save.", "history.restore": "Restore", "history.copy": "Copy", "history.copyHint": "Save as a new file in the same folder",
  "history.today": "Today {hm}", "history.yesterday": "Yesterday {hm}", "history.date": "{m}/{d} {hm}", "history.elements": "{reason} · {n} elements", "history.copyName": "{name} (version {stamp})",
  "reason.auto": "Auto", "reason.before_external": "Before outside change", "reason.before_conflict": "Before conflict merge", "reason.before_restore": "Before restore",
  "welcome.where": "Where should drawings live?", "welcome.desc": "Files are plain .excalidraw — excalidraw.com and the Obsidian plugin open them as is.",
  "welcome.icloudDesc": "Creates an “Excalidraw” folder in iCloud Drive that syncs across your Macs.", "welcome.local": "Local Folder",
  "welcome.localDesc": "Pick any folder — great for a git repo or another sync service.", "welcome.later": "You can add more folders from the sidebar later.",
  "welcome.new": "New Drawing", "welcome.open": "Open…", "welcome.recent": "Recent",
  "settings.title": "Settings", "settings.appearance": "Appearance", "settings.language": "Language", "settings.sort": "Sidebar order",
  "settings.system": "System", "settings.light": "Light", "settings.dark": "Dark", "settings.zh": "简体中文", "settings.en": "English",
  "settings.autoUpdate": "Update automatically", "settings.autoUpdateDesc": "Looks for a new release on GitHub at launch and every few hours, installs it and asks you to restart.",
  "settings.version": "Excalidesk {version}", "settings.checkNow": "Check Now", "settings.checking": "Checking…",
  "update.downloading": "Downloading Excalidesk {version}…", "update.ready": "Excalidesk {version} is installed. Restart to use it.", "update.restart": "Restart",
  "update.latest": "Excalidesk {version} is the latest version", "update.failed": "Couldn't update Excalidesk: {reason}", "update.installedOnly": "Updates work in the installed app only",
  "toast.onlyExcalidraw": "Only .excalidraw files can be opened", "toast.addFolderFirst": "Add a folder first — new drawings go there", "toast.mkdirFailed": "Couldn't create folder: {error}",
  "toast.created": "Created “{name}”", "toast.duplicateFailed": "Couldn't duplicate: {error}", "toast.trashed": "Moved “{name}” to Trash", "toast.trashFailed": "Couldn't move to Trash: {error}",
  "toast.pathCopied": "Path copied", "toast.exported": "Exported {name}", "toast.conflictFailed": "Couldn't merge iCloud conflict: {error}", "toast.externalFailed": "Couldn't read outside change: {error}",
  "toast.unsaved": "{n} file(s) didn't save ({names}). Close again to quit anyway.",
  "toast.unsavedRestart": "{n} file(s) didn't save ({names}). Click Restart again to restart anyway.",
  "dialog.pickFolder": "Choose a folder for your drawings", "dialog.trashTitle": "Move to Trash", "dialog.trashFolder": "Move the folder “{name}” and everything in it to the Trash?",
  "banner.externalN": "{n} elements changed outside the app", "banner.external": "File changed outside the app", "banner.merged": "{label} — merged with your unsaved edits (⌘Z to undo)",
  "banner.replaced": "{label} — loaded the latest version", "banner.conflicts": "Merged {n} conflicting version(s) from {from} (⌘Z to undo)", "banner.otherDevices": "other devices", "banner.device": "“{d}”",
  "banner.restored": "Restored the selected version (⌘Z to undo)",
  "err.no_icloud": "iCloud Drive isn't turned on on this Mac", "err.name_invalid": "Names can't be empty, contain / or :, or start with a dot", "err.exists": "“{0}” already exists",
  "err.no_parent": "No parent folder", "err.invalid_file": "Not a valid .excalidraw file: {0}", "err.not_open": "Document isn't open", "err.trash_failed": "Couldn't move to Trash", "err.reorder": "Workspaces changed — try again",
};

export type Key = keyof typeof zh;
const dicts: Record<Lang, typeof zh> = { zh, en };

export const systemLang = (): Lang => (navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en");

export function t(key: Key, vars: Record<string, string | number> = {}) {
  const s = dicts[getState().lang][key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

/** 组件里用：订阅语言变化 */
export function useT() {
  useShell((s) => s.lang);
  return t;
}

/** Rust 错误：`err.xxx` 或 `err.xxx:参数` → 当前语言；其他原样返回 */
export function tErr(e: unknown) {
  const s = String(e);
  const m = s.match(/^(err\.[a-z_]+)(?::([\s\S]*))?$/);
  if (!m || !(m[1] in zh)) return s;
  return dicts[getState().lang][m[1] as Key].replace("{0}", m[2] ?? "");
}
