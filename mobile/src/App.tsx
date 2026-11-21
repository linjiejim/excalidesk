import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  DarkTheme as NavDarkTheme,
  DefaultTheme as NavDefaultTheme,
  NavigationContainer,
  type NavigationContainerRef,
} from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackScreenProps } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
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
import { resolveLang, translate, type EffectiveLang, type I18nKey } from "./i18n";
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
import { DARK_THEME, LIGHT_THEME, type ThemeColors } from "./theme";
import type { DrawingFileItem, MobileSettings, RecentCollabLink, ViewerTarget } from "./types";
import {
  BrandMark,
  hapticSelection,
  NativeBlur,
  NativeIcon,
  showNativeActionSheet,
} from "./components/NativeUI";
import { FilesScreen } from "./screens/FilesScreen";
import { CollabScreen } from "./screens/CollabScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ViewerScreen } from "./screens/ViewerScreen";

type RootStackParamList = {
  Tabs: undefined;
  Viewer: { target: ViewerTarget };
};

type MainTabsParamList = {
  FilesTab: undefined;
  CollabTab: undefined;
  SettingsTab: undefined;
};

type SingleScreenParamList = {
  Index: undefined;
};

interface AppCtxValue {
  dark: boolean;
  theme: ThemeColors;
  lang: EffectiveLang;
  t: (k: I18nKey, vars?: Record<string, string | number>) => string;
  settings: MobileSettings;
  folders: SavedICloudFolder[];
  allFiles: DrawingFileItem[];
  favorites: Set<string>;
  recents: string[];
  recentCollab: RecentCollabLink[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  refreshing: boolean;
  openingId: string | null;
  refresh: () => void;
  openFile: (item: DrawingFileItem) => void;
  toggleStar: (id: string) => void;
  openCollabUrl: (url: string) => void;
  updateSettings: (patch: Partial<MobileSettings>) => void;
  connectICloudFolder: () => void;
  removeFolder: (id: string) => void;
  handleClearCache: () => void;
  openSortSheet: () => void;
  openAddSheet: () => void;
}

const AppCtx = createContext<AppCtxValue | null>(null);
function useAppCtx() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("AppCtx missing");
  return ctx;
}

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<MainTabsParamList>();
const FilesStack = createNativeStackNavigator<SingleScreenParamList>();
const CollabStack = createNativeStackNavigator<SingleScreenParamList>();
const SettingsStack = createNativeStackNavigator<SingleScreenParamList>();

function stripExcalidrawExt(name: string): string {
  return name.replace(/\.excalidraw$/i, "");
}

function useNativeHeaderOptions() {
  const { dark, theme } = useAppCtx();
  return useMemo(
    () => ({
      headerLargeTitle: Platform.OS === "ios",
      headerTransparent: Platform.OS === "ios",
      headerBlurEffect:
        Platform.OS === "ios"
          ? dark
            ? ("systemChromeMaterialDark" as const)
            : ("systemChromeMaterialLight" as const)
          : undefined,
      headerShadowVisible: Platform.OS !== "ios",
      headerStyle: Platform.OS === "ios" ? undefined : { backgroundColor: theme.bar },
      headerTintColor: theme.text,
      headerTitleStyle: { color: theme.text, fontWeight: "600" as const },
      headerLargeTitleStyle: { color: theme.text, fontWeight: "700" as const },
    }),
    [dark, theme],
  );
}

function FilesIndexRoute() {
  const ctx = useAppCtx();
  return (
    <FilesScreen
      files={ctx.allFiles}
      favorites={ctx.favorites}
      recents={ctx.recents}
      sort={ctx.settings.sort}
      searchQuery={ctx.searchQuery}
      onChangeSearch={ctx.setSearchQuery}
      refreshing={ctx.refreshing}
      openingId={ctx.openingId}
      theme={ctx.theme}
      lang={ctx.lang}
      onRefresh={ctx.refresh}
      onOpenFile={ctx.openFile}
      onToggleStar={ctx.toggleStar}
    />
  );
}

function FilesTabNavigator() {
  const { theme, t, setSearchQuery, openSortSheet, openAddSheet } = useAppCtx();
  const headerOptions = useNativeHeaderOptions();
  return (
    <FilesStack.Navigator screenOptions={headerOptions}>
      <FilesStack.Screen
        name="Index"
        component={FilesIndexRoute}
        options={{
          title: t("files.title"),
          headerLeft:
            Platform.OS === "ios"
              ? undefined
              : () => (
                  <View style={styles.brandLeft}>
                    <BrandMark theme={theme} size={20} />
                  </View>
                ),
          headerSearchBarOptions:
            Platform.OS === "ios"
              ? {
                  placeholder: t("files.searchPlaceholder"),
                  cancelButtonText: t("common.cancel"),
                  hideWhenScrolling: false,
                  onChangeText: (e) => setSearchQuery(e.nativeEvent.text),
                  onCancelButtonPress: () => setSearchQuery(""),
                }
              : undefined,
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable onPress={openSortSheet} hitSlop={8} style={styles.navIconBtn} accessibilityLabel="Sort">
                <NativeIcon name="arrow.up.arrow.down" size={17} color={theme.text} />
              </Pressable>
              <Pressable
                onPress={openAddSheet}
                hitSlop={8}
                style={styles.navIconBtn}
                accessibilityLabel={t("files.pickFile")}
              >
                <NativeIcon name="plus" size={19} color={theme.text} weight="medium" />
              </Pressable>
            </View>
          ),
        }}
      />
    </FilesStack.Navigator>
  );
}

function CollabIndexRoute() {
  const ctx = useAppCtx();
  return (
    <CollabScreen
      recentLinks={ctx.recentCollab}
      theme={ctx.theme}
      lang={ctx.lang}
      onOpenCollabUrl={ctx.openCollabUrl}
    />
  );
}

function CollabTabNavigator() {
  const { t } = useAppCtx();
  const headerOptions = useNativeHeaderOptions();
  return (
    <CollabStack.Navigator screenOptions={headerOptions}>
      <CollabStack.Screen name="Index" component={CollabIndexRoute} options={{ title: t("collab.title") }} />
    </CollabStack.Navigator>
  );
}

function SettingsIndexRoute() {
  const ctx = useAppCtx();
  return (
    <SettingsScreen
      settings={ctx.settings}
      folders={ctx.folders}
      theme={ctx.theme}
      lang={ctx.lang}
      onUpdateSettings={ctx.updateSettings}
      onAddFolder={ctx.connectICloudFolder}
      onRemoveFolder={ctx.removeFolder}
      onClearCache={ctx.handleClearCache}
    />
  );
}

function SettingsTabNavigator() {
  const { t } = useAppCtx();
  const headerOptions = useNativeHeaderOptions();
  return (
    <SettingsStack.Navigator screenOptions={headerOptions}>
      <SettingsStack.Screen name="Index" component={SettingsIndexRoute} options={{ title: t("settings.title") }} />
    </SettingsStack.Navigator>
  );
}

function MainTabsNavigator() {
  const { dark, theme, t } = useAppCtx();
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.text,
        tabBarInactiveTintColor: theme.muted,
        tabBarStyle:
          Platform.OS === "ios"
            ? {
                position: "absolute",
                borderTopColor: theme.separator,
                backgroundColor: "transparent",
              }
            : {
                backgroundColor: theme.bar,
                borderTopColor: theme.separator,
              },
        tabBarBackground:
          Platform.OS === "ios"
            ? () => <NativeBlur dark={dark} style={StyleSheet.absoluteFillObject} />
            : undefined,
      }}
    >
      <Tabs.Screen
        name="FilesTab"
        component={FilesTabNavigator}
        options={{
          title: t("tab.files"),
          tabBarIcon: ({ color, focused }) => (
            <NativeIcon name={focused ? "folder.fill" : "folder"} size={20} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="CollabTab"
        component={CollabTabNavigator}
        options={{
          title: t("tab.collab"),
          tabBarIcon: ({ color }) => <NativeIcon name="link" size={20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="SettingsTab"
        component={SettingsTabNavigator}
        options={{
          title: t("tab.settings"),
          tabBarIcon: ({ color, focused }) => (
            <NativeIcon name={focused ? "gearshape.fill" : "gearshape"} size={20} color={color} />
          ),
        }}
      />
    </Tabs.Navigator>
  );
}

function ViewerRoute({ route, navigation }: NativeStackScreenProps<RootStackParamList, "Viewer">) {
  const { dark, lang, settings } = useAppCtx();
  return (
    <ViewerScreen
      target={route.params.target}
      initialDark={dark}
      lang={lang}
      defaultServer={settings.collabServer}
      onClose={() => navigation.goBack()}
    />
  );
}

function RootApp() {
  const systemDark = useColorScheme() === "dark";
  const navRef = useRef<NavigationContainerRef<RootStackParamList>>(null);

  const [settings, setSettings] = useState<MobileSettings>(DEFAULT_SETTINGS);
  const [folders, setFolders] = useState<SavedICloudFolder[]>([]);
  const [icloudFiles, setICloudFiles] = useState<DrawingFileItem[]>([]);
  const [importedFiles, setImportedFiles] = useState<DrawingFileItem[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [recents, setRecents] = useState<string[]>([]);
  const [recentCollab, setRecentCollab] = useState<RecentCollabLink[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const dark = settings.theme === "system" ? systemDark : settings.theme === "dark";
  const theme = dark ? DARK_THEME : LIGHT_THEME;
  const lang = useMemo(() => resolveLang(settings.lang), [settings.lang]);
  const t = useCallback((k: I18nKey, vars?: Record<string, string | number>) => translate(lang, k, vars), [lang]);

  const navTheme = useMemo(() => {
    const base = dark ? NavDarkTheme : NavDefaultTheme;
    return {
      ...base,
      dark,
      colors: {
        ...base.colors,
        primary: theme.text,
        background: theme.bg,
        card: theme.bar,
        text: theme.text,
        border: theme.separator,
        notification: theme.danger,
      },
    };
  }, [dark, theme]);

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

  const pushViewer = useCallback((target: ViewerTarget) => {
    navRef.current?.navigate("Viewer", { target });
  }, []);

  const openCollabUrl = useCallback(
    (url: string) => {
      const parsed = parseMobileCollabLink(url);
      if (!parsed) return;
      const entry: RecentCollabLink = {
        id: `${parsed.kind}:${parsed.id}`,
        url,
        kind: parsed.kind,
        title:
          parsed.kind === "room"
            ? `${t("collab.roomBadge")} · ${parsed.id.slice(0, 6)}`
            : `${t("collab.shareBadge")} · ${parsed.id.slice(0, 6)}`,
        openedAt: Date.now(),
      };
      setRecentCollab((prev) => {
        const next = [entry, ...prev.filter((x) => x.id !== entry.id)].slice(0, 20);
        void saveRecentCollabLinks(next);
        return next;
      });
      pushViewer({ kind: "collab", collabUrl: url, title: entry.title });
    },
    [pushViewer, t],
  );

  const importRawFile = useCallback(
    (name: string, rawJson: string, localUri?: string) => {
      const doc = parseExcalidrawJson(rawJson);
      const summary = summarizeScene(doc);
      const cleanName = stripExcalidrawExt(name);
      const item: DrawingFileItem = {
        id: `imported:${localUri || cleanName}:${Date.now()}`,
        name: cleanName,
        folderName: t("files.icloudTag"),
        relativePath: name,
        source: "imported",
        localUri,
        mtime: Date.now(),
        size: rawJson.length,
        isUbiquitous: false,
        downloaded: true,
        elementCount: summary.liveCount,
        slideCount: summary.slideCount,
        searchText: summary.searchText,
        rawJson,
      };
      setImportedFiles((prev) => {
        const next = [item, ...prev.filter((x) => x.name !== item.name)].slice(0, 50);
        void saveImportedFiles(next);
        return next;
      });
      pushViewer({ kind: "file", file: item, rawJson, title: item.name });
    },
    [pushViewer, t],
  );

  useEffect(() => {
    const handleIncomingUrl = async (url: string | null) => {
      if (!url) return;
      if (parseMobileCollabLink(url)) {
        openCollabUrl(url);
        return;
      }
      if (url.startsWith("file://") || url.toLowerCase().includes(".excalidraw")) {
        try {
          const rawJson = isNativeICloudModuleAvailable
            ? await readExternalICloudUri(url)
            : await FileSystem.readAsStringAsync(url, { encoding: FileSystem.EncodingType.UTF8 });
          const rawName = decodeURIComponent(url.split("/").pop() || "Drawing.excalidraw");
          importRawFile(rawName, rawJson, url);
        } catch (e) {
          Alert.alert(t("files.title"), t("files.openFailed", { err: String(e) }));
        }
      }
    };
    void Linking.getInitialURL().then(handleIncomingUrl);
    const sub = Linking.addEventListener("url", (ev) => {
      void handleIncomingUrl(ev.url);
    });
    return () => sub.remove();
  }, [openCollabUrl, importRawFile, t]);

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
      const folder = await pickICloudFolder();
      if (!folder) return;
      await refresh();
    } catch (e) {
      Alert.alert(t("files.title"), String(e));
    }
  }, [refresh, t]);

  const pickSingleFile = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["application/json", "public.json", "public.data", "*/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled || !res.assets?.length) return;
      const asset = res.assets[0];
      const rawJson = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
      importRawFile(asset.name, rawJson, asset.uri);
    } catch (e) {
      Alert.alert(t("files.title"), t("files.openFailed", { err: String(e) }));
    }
  }, [importRawFile, t]);

  const openFile = useCallback(
    async (item: DrawingFileItem) => {
      markRecent(item.id);
      if (item.rawJson) {
        pushViewer({ kind: "file", file: item, rawJson: item.rawJson, title: item.name });
        return;
      }
      setOpeningId(item.id);
      try {
        let rawJson = "";
        if (item.source === "icloud-folder" && item.folderId) {
          rawJson = await readICloudFile(item.folderId, item.relativePath);
        } else if (item.localUri) {
          rawJson = await FileSystem.readAsStringAsync(item.localUri, { encoding: FileSystem.EncodingType.UTF8 });
        }
        const summary = summarizeScene(parseExcalidrawJson(rawJson));
        setICloudFiles((prev) =>
          prev.map((x) =>
            x.id === item.id
              ? {
                  ...x,
                  downloaded: true,
                  elementCount: summary.liveCount,
                  slideCount: summary.slideCount,
                  searchText: summary.searchText,
                  rawJson,
                }
              : x,
          ),
        );
        pushViewer({ kind: "file", file: item, rawJson, title: item.name });
      } catch (e) {
        Alert.alert(t("files.title"), t("files.openFailed", { err: String(e) }));
      } finally {
        setOpeningId(null);
      }
    },
    [markRecent, pushViewer, t],
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

  const openSortSheet = useCallback(() => {
    showNativeActionSheet({
      cancelLabel: t("common.cancel"),
      items: [
        {
          label: `${settings.sort === "mtime" ? "✓ " : ""}${t("files.sortMtime")}`,
          onPress: () => {
            hapticSelection();
            updateSettings({ sort: "mtime" });
          },
        },
        {
          label: `${settings.sort === "name" ? "✓ " : ""}${t("files.sortName")}`,
          onPress: () => {
            hapticSelection();
            updateSettings({ sort: "name" });
          },
        },
      ],
    });
  }, [settings.sort, t, updateSettings]);

  const openAddSheet = useCallback(() => {
    if (!isNativeICloudModuleAvailable) {
      void pickSingleFile();
      return;
    }
    showNativeActionSheet({
      cancelLabel: t("common.cancel"),
      items: [
        { label: t("files.connectICloud"), onPress: () => void connectICloudFolder() },
        { label: t("files.pickFile"), onPress: () => void pickSingleFile() },
      ],
    });
  }, [connectICloudFolder, pickSingleFile, t]);

  const allFiles = useMemo(() => {
    const combined = [...icloudFiles, ...importedFiles];
    return combined.length > 0 ? [...combined, ...SAMPLE_DRAWINGS] : SAMPLE_DRAWINGS;
  }, [icloudFiles, importedFiles]);

  const ctxValue = useMemo<AppCtxValue>(
    () => ({
      dark,
      theme,
      lang,
      t,
      settings,
      folders,
      allFiles,
      favorites,
      recents,
      recentCollab,
      searchQuery,
      setSearchQuery,
      refreshing,
      openingId,
      refresh: () => void refresh(),
      openFile: (f) => void openFile(f),
      toggleStar,
      openCollabUrl,
      updateSettings,
      connectICloudFolder: () => void connectICloudFolder(),
      removeFolder,
      handleClearCache,
      openSortSheet,
      openAddSheet,
    }),
    [
      allFiles,
      connectICloudFolder,
      dark,
      favorites,
      folders,
      handleClearCache,
      lang,
      openAddSheet,
      openCollabUrl,
      openFile,
      openSortSheet,
      openingId,
      recentCollab,
      recents,
      refresh,
      refreshing,
      removeFolder,
      searchQuery,
      settings,
      t,
      theme,
      toggleStar,
      updateSettings,
    ],
  );

  return (
    <AppCtx.Provider value={ctxValue}>
      <NavigationContainer ref={navRef} theme={navTheme}>
        <StatusBar style={dark ? "light" : "dark"} />
        <RootStack.Navigator screenOptions={{ headerShown: false }}>
          <RootStack.Screen name="Tabs" component={MainTabsNavigator} />
          <RootStack.Screen
            name="Viewer"
            component={ViewerRoute}
            options={{
              animation: "default",
              gestureEnabled: true,
            }}
          />
        </RootStack.Navigator>
      </NavigationContainer>
    </AppCtx.Provider>
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
  brandLeft: {
    marginLeft: 14,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginRight: Platform.OS === "ios" ? 0 : 8,
  },
  navIconBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
});
