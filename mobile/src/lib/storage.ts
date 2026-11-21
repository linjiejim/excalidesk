import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DrawingFileItem, MobileSettings, RecentCollabLink } from "../types.ts";

const KEYS = {
  settings: "excalidesk.mobile.settings.v1",
  favorites: "excalidesk.mobile.favorites.v1",
  recents: "excalidesk.mobile.recents.v1",
  imported: "excalidesk.mobile.imported.v1",
  collabLinks: "excalidesk.mobile.collabLinks.v1",
};

export const DEFAULT_SETTINGS: MobileSettings = {
  theme: "system",
  lang: "system",
  sort: "mtime",
  collabServer: "http://localhost:3456",
};

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

export const loadSettings = async (): Promise<MobileSettings> => ({
  ...DEFAULT_SETTINGS,
  ...(await readJson<Partial<MobileSettings>>(KEYS.settings, {})),
});
export const saveSettings = (s: MobileSettings) => writeJson(KEYS.settings, s);

export const loadFavorites = () => readJson<string[]>(KEYS.favorites, []);
export const saveFavorites = (ids: string[]) => writeJson(KEYS.favorites, ids);

export const loadRecents = () => readJson<string[]>(KEYS.recents, []);
export const saveRecents = (ids: string[]) => writeJson(KEYS.recents, ids.slice(0, 30));

export const loadImportedFiles = () => readJson<DrawingFileItem[]>(KEYS.imported, []);
export const saveImportedFiles = (items: DrawingFileItem[]) =>
  // Keep metadata + lightweight rawJson cap to avoid blowing AsyncStorage limits
  writeJson(
    KEYS.imported,
    items.slice(0, 40).map((f) => ({
      ...f,
      rawJson: f.rawJson && f.rawJson.length < 300_000 ? f.rawJson : undefined,
    })),
  );

export const loadRecentCollabLinks = () => readJson<RecentCollabLink[]>(KEYS.collabLinks, []);
export const saveRecentCollabLinks = (links: RecentCollabLink[]) => writeJson(KEYS.collabLinks, links.slice(0, 20));

export async function clearMobileCache(): Promise<void> {
  await AsyncStorage.multiRemove([KEYS.recents, KEYS.imported, KEYS.collabLinks]);
}
