export type ThemeSetting = "system" | "light" | "dark";
export type LangSetting = "system" | "zh" | "en";
export type SortMode = "mtime" | "name";

export interface MobileSettings {
  theme: ThemeSetting;
  lang: LangSetting;
  sort: SortMode;
  collabServer: string;
}

export type FileSourceKind = "icloud-folder" | "imported" | "sample";

export interface DrawingFileItem {
  id: string;
  name: string;
  folderName: string;
  relativePath: string;
  source: FileSourceKind;
  folderId?: string;
  localUri?: string;
  mtime: number;
  size: number;
  isUbiquitous: boolean;
  downloaded: boolean;
  downloading?: boolean;
  /** Cached parsed summary for instant search & thumbnail rendering */
  elementCount?: number;
  slideCount?: number;
  searchText?: string;
  rawJson?: string;
}

export interface RecentCollabLink {
  id: string;
  url: string;
  kind: "room" | "share";
  title: string;
  openedAt: number;
}

export interface ViewerTarget {
  kind: "file" | "collab";
  file?: DrawingFileItem;
  rawJson?: string;
  collabUrl?: string;
  title: string;
}
