import type { LangSetting } from "./types.ts";

export type EffectiveLang = "zh" | "en";

const zh = {
  "tab.files": "文件",
  "tab.collab": "协作链接",
  "tab.settings": "设置",
  "files.title": "Excalidesk",
  "files.searchPlaceholder": "搜索文件名或图内文字…",
  "files.connectICloud": "连接 iCloud 文件夹",
  "files.pickFile": "从 iCloud 打开文件",
  "files.filterAll": "全部",
  "files.filterStarred": "收藏",
  "files.filterRecent": "最近",
  "files.sortMtime": "最近修改",
  "files.sortName": "名称",
  "files.empty": "还没有 Excalidraw 文件",
  "files.emptyHint": "点击上方按钮连接你的 iCloud Drive 文件夹，或直接从「文件」中选择 .excalidraw 预览。",
  "files.cloudOnly": "仅在 iCloud",
  "files.downloading": "正在从 iCloud 下载…",
  "files.elements": "{n} 个元素",
  "files.slides": "{n} 页",
  "files.sampleTag": "示例",
  "files.icloudTag": "iCloud",
  "files.expoGoHint": "当前在 Expo Go 中运行，可使用「从 iCloud 打开文件」逐个打开；用 EAS / Xcode 构建开发版后支持整文件夹同步。",
  "files.openFailed": "无法打开文件：{err}",
  "viewer.fit": "适配屏幕",
  "viewer.slides": "幻灯片",
  "viewer.notes": "演讲者备注",
  "viewer.noNotes": "这一页没有备注",
  "viewer.share": "分享",
  "viewer.shareFile": "分享 .excalidraw 文件",
  "viewer.shareLink": "生成端到端加密分享链接",
  "viewer.linkCopied": "已生成加密链接",
  "viewer.live": "实时协作",
  "viewer.readonly": "只读预览",
  "viewer.peers": "{n} 人在线",
  "viewer.connecting": "正在连接协作房间…",
  "viewer.decrypting": "正在端到端解密…",
  "viewer.error": "无法加载画布：{err}",
  "viewer.empty": "这是一张空白画布",
  "collab.title": "分享与实时协作",
  "collab.desc": "粘贴 Excalidesk 桌面端生成的只读分享链接或多人实时协作链接，在手机上实时查看。",
  "collab.placeholder": "https://.../#room=... 或 #share=...",
  "collab.open": "打开预览",
  "collab.invalid": "请输入有效的 Excalidesk 协作或分享链接",
  "collab.recent": "最近打开的链接",
  "collab.recentEmpty": "还没有打开过协作或分享链接",
  "collab.roomBadge": "实时协作",
  "collab.shareBadge": "只读分享",
  "collab.e2ee": "端到端加密：密钥仅保存在 URL # 后，服务端无法读取画布内容。",
  "settings.title": "设置",
  "settings.appearance": "外观",
  "settings.system": "跟随系统",
  "settings.light": "浅色",
  "settings.dark": "深色",
  "settings.language": "语言",
  "settings.icloudFolders": "已连接的 iCloud 文件夹",
  "settings.noFolders": "尚未连接文件夹",
  "settings.addFolder": "添加 iCloud 文件夹",
  "settings.remove": "移除",
  "settings.nativeActive": "原生 iCloud Drive 模块已启用",
  "settings.nativeFallback": "Expo Go 兼容模式（使用系统文件选择器访问 iCloud）",
  "settings.server": "自部署协作服务器",
  "settings.serverHint": "用于从手机生成只读分享链接，支持开源自部署（docker compose up -d）。",
  "settings.clearCache": "清除本地缓存",
  "settings.cacheCleared": "本地缓存已清除",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.done": "完成",
};

const en: typeof zh = {
  "tab.files": "Files",
  "tab.collab": "Shared",
  "tab.settings": "Settings",
  "files.title": "Excalidesk",
  "files.searchPlaceholder": "Search filenames or text in drawings…",
  "files.connectICloud": "Connect iCloud Folder",
  "files.pickFile": "Open from iCloud",
  "files.filterAll": "All",
  "files.filterStarred": "Starred",
  "files.filterRecent": "Recent",
  "files.sortMtime": "Modified",
  "files.sortName": "Name",
  "files.empty": "No Excalidraw files yet",
  "files.emptyHint": "Connect your iCloud Drive folder above, or pick any .excalidraw file from iOS Files to preview.",
  "files.cloudOnly": "In iCloud",
  "files.downloading": "Downloading from iCloud…",
  "files.elements": "{n} elements",
  "files.slides": "{n} slides",
  "files.sampleTag": "Sample",
  "files.icloudTag": "iCloud",
  "files.expoGoHint": "Running in Expo Go: use “Open from iCloud” to preview files. Build with EAS / Xcode for persistent iCloud folder sync.",
  "files.openFailed": "Could not open file: {err}",
  "viewer.fit": "Fit",
  "viewer.slides": "Slides",
  "viewer.notes": "Speaker Notes",
  "viewer.noNotes": "No speaker notes for this slide",
  "viewer.share": "Share",
  "viewer.shareFile": "Share .excalidraw File",
  "viewer.shareLink": "Create E2EE Share Link",
  "viewer.linkCopied": "Encrypted share link ready",
  "viewer.live": "Live",
  "viewer.readonly": "Read-only",
  "viewer.peers": "{n} online",
  "viewer.connecting": "Connecting to live room…",
  "viewer.decrypting": "Decrypting end-to-end…",
  "viewer.error": "Unable to load drawing: {err}",
  "viewer.empty": "This drawing is empty",
  "collab.title": "Share & Live Collab",
  "collab.desc": "Paste an Excalidesk read-only share link or live collaboration room link to preview on mobile.",
  "collab.placeholder": "https://.../#room=... or #share=...",
  "collab.open": "Open Preview",
  "collab.invalid": "Please enter a valid Excalidesk share or collab link",
  "collab.recent": "Recent Links",
  "collab.recentEmpty": "No shared or collab links opened yet",
  "collab.roomBadge": "Live Room",
  "collab.shareBadge": "Snapshot",
  "collab.e2ee": "End-to-end encrypted: keys stay in the URL # fragment and never reach the server.",
  "settings.title": "Settings",
  "settings.appearance": "Appearance",
  "settings.system": "System",
  "settings.light": "Light",
  "settings.dark": "Dark",
  "settings.language": "Language",
  "settings.icloudFolders": "Connected iCloud Folders",
  "settings.noFolders": "No folders connected yet",
  "settings.addFolder": "Add iCloud Folder",
  "settings.remove": "Remove",
  "settings.nativeActive": "Native iCloud Drive module active",
  "settings.nativeFallback": "Expo Go compatibility mode (uses iOS Files picker for iCloud)",
  "settings.server": "Self-hosted Collab Server",
  "settings.serverHint": "Used when creating encrypted share links from mobile. Self-host with docker compose up -d.",
  "settings.clearCache": "Clear Local Cache",
  "settings.cacheCleared": "Local cache cleared",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.done": "Done",
};

export type I18nKey = keyof typeof zh;

export function resolveLang(setting: LangSetting): EffectiveLang {
  if (setting !== "system") return setting;
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "en";
  }
}

export function translate(lang: EffectiveLang, key: I18nKey, vars?: Record<string, string | number>): string {
  const dict = lang === "zh" ? zh : en;
  let text = dict[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}
