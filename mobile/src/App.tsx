import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, useColorScheme, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Linking from "expo-linking";
import {
  isNativeICloudModuleAvailable,
  listSavedFolders,
  pickICloudFolder,
  readExternalICloudUri,
  readICloudFile,
  removeSavedFolder,
  scanICloudFolder,
  type SavedICloudFolder,
} from "../modules/icloud-files";
import { resolveLang, translate, type I18nKey } from "./i18n";
import { parseMobileCollabLink } from "./lib/collabLinks";
import { parseExcalidrawJson, summarizeScene } from "./lib/excalidraw";
import { SAMPLE_DRAWINGS } from "./lib/samples";
import {
  clearMobileCache,
  DEFAULT_SETTINGS,
  loadFavorites,
  loadImportedFiles,
  loadRecentCollabLinks,
  loadRecents,
  loadSettings,
  saveFavorites,
  saveImportedFiles,
  saveRecentCollabLinks,
  saveRecents,
  saveSettings,
} from "./lib/storage";
import { DARK_THEME, LIGHT_THEME } from "./theme";
import type { DrawingFileItem, MobileSettings, RecentCollabLink, ViewerTarget } from "./types";
import { FilesScreen } from "./screens/FilesScreen";
import { CollabScreen } from "./screens/CollabScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ViewerScreen } from "./screens/ViewerScreen";

type BottomTab = "files" | "collab" | "settings";

function stripExcalidrawExt(name: string): string {
  return name.replace(/\.excalidraw$/i, "");
}

function RootApp() {
  const systemDark = useColorScheme() === "dark";
  const [settings, setSettings] = useState<MobileSettings>(DEFAULT_SETTINGS);
  const [tab, setTab] = useState<BottomTab>("files");
  const [folders, setFolders] = useState<SavedICloudFolder[]>([]);
  const [icloudFiles, setICloudFiles] = useState<DrawingFileItem[]>([]);
  const [importedFiles, setImportedFiles] = useState<DrawingFileItem[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [recents, setRecents] = useState<string[]>([]);
  const [recentCollab, setRecentCollab] = useState<RecentCollabLink[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);

  const dark = settings.theme === "system" ? systemDark : settings.theme === "dark";
  const theme = dark ? DARK_THEME : LIGHT_THEME;
  const lang = useMemo(() => resolveLang(settings.lang), [settings.lang]);
  const t = useCallback((k: I18nKey, vars?: Record<string, string | number>) => translate(lang, k, vars), [lang]);

  const scanAllFolders = useCallback(async (folderList: SavedICloudFolder[]) => {
    if (!isNativeICloudModuleAvailable || folderList.length === 0) {
      setICloudFiles([]);
      return;
    }
    const items: DrawingFileItem[] = [];
    for (const folder of folderList) {
      try {
        const scanned = await scanICloudFolder(folder.id);
        for (const f of scanned) {
          items.push({
            id: `icloud:${folder.id}:${f.relativePath}`,
            name: f.name,
            folderName: folder.name,
            relativePath: f.relativePath,
            source: "icloud-folder",
            folderId: folder.id,
            mtime: f.mtime,
            size: f.size,
            isUbiquitous: f.isUbiquitous,
            downloaded: f.downloaded,
            downloading: f.downloading,
          });
        }
      } catch {
        // Folder may have been moved or revoked
      }
    }
    setICloudFiles(items);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const saved = listSavedFolders();
      setFolders(saved);
      await scanAllFolders(saved);
    } finally {
      setRefreshing(false);
    }
  }, [scanAllFolders]);

  useEffect(() => {
    (async () => {
      const [st, favs, recs, imp, links] = await Promise.all([
        loadSettings(),
        loadFavorites(),
        loadRecents(),
        loadImportedFiles(),
        loadRecentCollabLinks(),
      ]);
      setSettings(st);
      setFavorites(new Set(favs));
      setRecents(recs);
      setImportedFiles(imp);
      setRecentCollab(links);
      await refresh();
    })();
  }, [refresh]);

  const openCollabUrl = useCallback(
    (url: string) => {
      const parsed = parseMobileCollabLink(url);
      if (!parsed) return;
      const entry: RecentCollabLink = {
        id: `${parsed.kind}:${parsed.id}`,
        url,
        kind: parsed.kind,
        title: parsed.kind === "room" ? `${t("collab.roomBadge")} · ${parsed.id.slice(0, 6)}` : `${t("collab.shareBadge")} · ${parsed.id.slice(0, 6)}`,
        openedAt: Date.now(),
      };
      setRecentCollab((prev) => {
        const next = [entry, ...prev.filter((x) => x.id !== entry.id)].slice(0, 20);
        void saveRecentCollabLinks(next);
        return next;
      });
      setViewer({ kind: "collab", collabUrl: url, title: entry.title });
    },
    [t],
  );

  // Handle incoming deep links (excalidesk://... or iOS "Open In" file://...excalidraw)
  useEffect(() => {
    const handleIncomingUrl = async (url: string | null) => {
      if (!url) return;
      const collab = parseMobileCollabLink(url);
      if (collab) {
        openCollabUrl(url);
        return;
      }
      if (url.startsWith("file://") && url.toLowerCase().includes(".excalidraw")) {
        try {
          const rawJson = isNativeICloudModuleAvailable
            ? await readExternalICloudUri(url)
            : await FileSystem.readAsStringAsync(url, { encoding: FileSystem.EncodingType.UTF8 });
          const summary = summarizeScene(parseExcalidrawJson(rawJson));
          const fileName = decodeURIComponent(url.split("/").pop() || "Drawing");
          const item: DrawingFileItem = {
            id: `imported:${fileName}:${Date.now()}`,
            name: stripExcalidrawExt(fileName),
            folderName: "iCloud Drive",
            relativePath: fileName,
            source: "imported",
            localUri: url,
            mtime: Date.now(),
            size: rawJson.length,
            isUbiquitous: true,
            downloaded: true,
            elementCount: summary.liveCount,
            slideCount: summary.slideCount,
            searchText: summary.searchText,
            rawJson,
          };
          setImportedFiles((prev) => {
            const next = [item, ...prev.filter((x) => x.name !== item.name)];
            void saveImportedFiles(next);
            return next;
          });
          setViewer({ kind: "file", file: item, rawJson, title: item.name });
        } catch (e) {
          Alert.alert(t("files.title"), t("files.openFailed", { err: String(e) }));
        }
      }
    };

    void Linking.getInitialURL().then(handleIncomingUrl);
    const sub = Linking.addEventListener("url", (ev) => void handleIncomingUrl(ev.url));
    return () => sub.remove();
  }, [openCollabUrl, t]);

  const updateSettings = useCallback((patch: Partial<MobileSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);

  const toggleStar = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      void saveFavorites([...next]);
      return next;
    });
  }, []);

  const markRecent = useCallback((id: string) => {
    setRecents((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, 30);
      void saveRecents(next);
      return next;
    });
  }, []);

  const connectICloudFolder = useCallback(async () => {
    try {
      const picked = await pickICloudFolder();
      if (!picked) return;
      await refresh();
    } catch (e) {
      Alert.alert(t("files.title"), String(e));
    }
  }, [refresh, t]);

  const pickSingleFile = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["*/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled || !res.assets?.length) return;
      const asset = res.assets[0];
      const rawJson = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
      const parsed = parseExcalidrawJson(rawJson);
      const summary = summarizeScene(parsed);
      const item: DrawingFileItem = {
        id: `imported:${asset.name}:${asset.size ?? Date.now()}`,
        name: stripExcalidrawExt(asset.name),
        folderName: "iCloud Drive",
        relativePath: asset.name,
        source: "imported",
        localUri: asset.uri,
        mtime: Date.now(),
        size: asset.size ?? rawJson.length,
        isUbiquitous: true,
        downloaded: true,
        elementCount: summary.liveCount,
        slideCount: summary.slideCount,
        searchText: summary.searchText,
        rawJson,
      };
      setImportedFiles((prev) => {
        const next = [item, ...prev.filter((x) => x.id !== item.id)];
        void saveImportedFiles(next);
        return next;
      });
      markRecent(item.id);
      setViewer({ kind: "file", file: item, rawJson, title: item.name });
    } catch (e) {
      Alert.alert(t("files.title"), t("files.openFailed", { err: String(e) }));
    }
  }, [markRecent, t]);

  const openFile = useCallback(
    async (item: DrawingFileItem) => {
      if (item.rawJson) {
        markRecent(item.id);
        setViewer({ kind: "file", file: item, rawJson: item.rawJson, title: item.name });
        return;
      }

      setOpeningId(item.id);
      try {
        let rawJson = "";
        if (item.source === "icloud-folder" && item.folderId) {
          rawJson = await readICloudFile(item.folderId, item.relativePath);
        } else if (item.localUri) {
          rawJson = await FileSystem.readAsStringAsync(item.localUri, { encoding: FileSystem.EncodingType.UTF8 });
        } else {
          throw new Error("File source unavailable");
        }
        const summary = summarizeScene(parseExcalidrawJson(rawJson));
        if (item.source === "icloud-folder") {
          setICloudFiles((prev) =>
            prev.map((f) =>
              f.id === item.id
                ? {
                    ...f,
                    downloaded: true,
                    elementCount: summary.liveCount,
                    slideCount: summary.slideCount,
                    searchText: summary.searchText,
                    rawJson: rawJson.length < 400_000 ? rawJson : undefined,
                  }
                : f,
            ),
          );
        }
        markRecent(item.id);
        setViewer({ kind: "file", file: item, rawJson, title: item.name });
      } catch (e) {
        Alert.alert(t("files.title"), t("files.openFailed", { err: String(e) }));
      } finally {
        setOpeningId(null);
      }
    },
    [markRecent, t],
  );

  const removeFolder = useCallback(
    (folderId: string) => {
      removeSavedFolder(folderId);
      void refresh();
    },
    [refresh],
  );

  const handleClearCache = useCallback(() => {
    void clearMobileCache();
    setImportedFiles([]);
    setRecents([]);
    setRecentCollab([]);
  }, []);

  const allFiles = useMemo(() => {
    const combined = [...icloudFiles, ...importedFiles];
    return combined.length > 0 ? [...combined, ...SAMPLE_DRAWINGS] : SAMPLE_DRAWINGS;
  }, [icloudFiles, importedFiles]);

  if (viewer) {
    return (
      <>
        <StatusBar style={dark ? "light" : "dark"} />
        <ViewerScreen
          target={viewer}
          initialDark={dark}
          lang={lang}
          defaultServer={settings.collabServer}
          onClose={() => setViewer(null)}
        />
      </>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]} edges={["top", "bottom"]}>
      <StatusBar style={dark ? "light" : "dark"} />
      <View style={styles.content}>
        {tab === "files" && (
          <FilesScreen
            files={allFiles}
            favorites={favorites}
            recents={recents}
            sort={settings.sort}
            refreshing={refreshing}
            openingId={openingId}
            theme={theme}
            lang={lang}
            onRefresh={() => void refresh()}
            onOpenFile={(f) => void openFile(f)}
            onToggleStar={toggleStar}
            onPickSingleFile={() => void pickSingleFile()}
            onConnectICloudFolder={() => void connectICloudFolder()}
            onChangeSort={(sort) => updateSettings({ sort })}
          />
        )}
        {tab === "collab" && (
          <CollabScreen recentLinks={recentCollab} theme={theme} lang={lang} onOpenCollabUrl={openCollabUrl} />
        )}
        {tab === "settings" && (
          <SettingsScreen
            settings={settings}
            folders={folders}
            theme={theme}
            lang={lang}
            onUpdateSettings={updateSettings}
            onAddFolder={() => void connectICloudFolder()}
            onRemoveFolder={removeFolder}
            onClearCache={handleClearCache}
          />
        )}
      </View>

      <View style={[styles.tabBar, { backgroundColor: theme.bar, borderTopColor: theme.border }]}>
        {(
          [
            ["files", "☁", t("tab.files")],
            ["collab", "⇄", t("tab.collab")],
            ["settings", "⚙", t("tab.settings")],
          ] as [BottomTab, string, string][]
        ).map(([key, icon, label]) => {
          const active = tab === key;
          return (
            <Pressable key={key} onPress={() => setTab(key)} style={styles.tabItem}>
              <Text style={[styles.tabIcon, { color: active ? theme.text : theme.muted }]}>{icon}</Text>
              <Text style={[styles.tabLabel, { color: active ? theme.text : theme.muted }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <RootApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  tabBar: {
    flexDirection: "row",
    height: 56,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  tabIcon: {
    fontSize: 18,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
});
