import type { LangSetting } from "./types.ts";

export type EffectiveLang = "zh" | "en";

const zh = {
  "tab.files": "文件",
  "tab.collab": "协作",
  "tab.settings": "设置",
  "files.title": "Excalidesk",
  "files.searchPlaceholder": "搜索…",
  "files.connectICloud": "添加文件夹",
  "files.pickFile": "打开",
  "files.filterAll": "全部",
  "files.filterStarred": "收藏",
  "files.filterRecent": "最近",
  "files.sortMtime": "最近修改",
  "files.sortName": "名称",
  "files.empty": "还没有图",
  "files.emptyHint": "点右上角打开 iCloud Drive 里的 .excalidraw 文件。",
  "files.cloudOnly": "仅在 iCloud",
  "files.downloading": "正在下载…",
  "files.elements": "{n} 个元素",
  "files.slides": "{n} 页",
  "files.sampleTag": "示例",
  "files.icloudTag": "iCloud",
  "files.openFailed": "打不开：{err}",
  "viewer.fit": "适配",
  "viewer.slides": "幻灯片",
  "viewer.notes": "备注",
  "viewer.noNotes": "这一页没有备注",
  "viewer.share": "分享",
  "viewer.shareFile": "分享文件",
  "viewer.shareLink": "拷贝只读链接",
  "viewer.linkCopied": "已生成链接",
  "viewer.live": "实时协作",
  "viewer.readonly": "只读",
  "viewer.peers": "{n} 人在线",
  "viewer.connecting": "连接中…",
  "viewer.decrypting": "加载中…",
  "viewer.error": "打不开：{err}",
  "viewer.empty": "空画布",
  "collab.title": "协作",
  "collab.placeholder": "粘贴协作或分享链接…",
  "collab.open": "打开",
  "collab.invalid": "链接无效",
  "collab.recent": "最近",
  "collab.recentEmpty": "暂无记录",
  "collab.roomBadge": "协作",
  "collab.shareBadge": "只读",
  "collab.e2ee": "端到端加密",
  "settings.title": "设置",
  "settings.appearance": "外观",
  "settings.system": "跟随系统",
  "settings.light": "浅色",
  "settings.dark": "深色",
  "settings.language": "语言",
  "settings.icloudFolders": "iCloud 文件夹",
  "settings.noFolders": "还没有文件夹",
  "settings.addFolder": "添加文件夹",
  "settings.remove": "移除",
  "settings.nativeActive": "已启用原生 iCloud 同步",
  "settings.nativeFallback": "Expo Go 模式（单文件打开；开发版支持整文件夹同步）",
  "settings.server": "协作服务器",
  "settings.clearCache": "清除缓存",
  "settings.cacheCleared": "已清除",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.done": "完成",
};

const en: typeof zh = {
  "tab.files": "Files",
  "tab.collab": "Collab",
  "tab.settings": "Settings",
  "files.title": "Excalidesk",
  "files.searchPlaceholder": "Search…",
  "files.connectICloud": "Add Folder",
  "files.pickFile": "Open",
  "files.filterAll": "All",
  "files.filterStarred": "Starred",
  "files.filterRecent": "Recent",
  "files.sortMtime": "Modified",
  "files.sortName": "Name",
  "files.empty": "No drawings yet",
  "files.emptyHint": "Tap Open above to preview a .excalidraw file from iCloud Drive.",
  "files.cloudOnly": "iCloud",
  "files.downloading": "Downloading…",
  "files.elements": "{n} elements",
  "files.slides": "{n} slides",
  "files.sampleTag": "Sample",
  "files.icloudTag": "iCloud",
  "files.openFailed": "Can't open: {err}",
  "viewer.fit": "Fit",
  "viewer.slides": "Slides",
  "viewer.notes": "Notes",
  "viewer.noNotes": "No notes for this slide",
  "viewer.share": "Share",
  "viewer.shareFile": "Share File",
  "viewer.shareLink": "Copy Read-only Link",
  "viewer.linkCopied": "Link ready",
  "viewer.live": "Live",
  "viewer.readonly": "Read-only",
  "viewer.peers": "{n} online",
  "viewer.connecting": "Connecting…",
  "viewer.decrypting": "Loading…",
  "viewer.error": "Can't open: {err}",
  "viewer.empty": "Empty canvas",
  "collab.title": "Collab",
  "collab.placeholder": "Paste a collab or share link…",
  "collab.open": "Open",
  "collab.invalid": "Invalid link",
  "collab.recent": "Recent",
  "collab.recentEmpty": "No recent links",
  "collab.roomBadge": "Live",
  "collab.shareBadge": "View",
  "collab.e2ee": "End-to-end encrypted",
  "settings.title": "Settings",
  "settings.appearance": "Appearance",
  "settings.system": "System",
  "settings.light": "Light",
  "settings.dark": "Dark",
  "settings.language": "Language",
  "settings.icloudFolders": "iCloud Folders",
  "settings.noFolders": "No folders yet",
  "settings.addFolder": "Add Folder",
  "settings.remove": "Remove",
  "settings.nativeActive": "Native iCloud sync active",
  "settings.nativeFallback": "Expo Go mode (single-file picker; dev build enables folder sync)",
  "settings.server": "Collab server",
  "settings.clearCache": "Clear Cache",
  "settings.cacheCleared": "Cache cleared",
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
