import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Svg, { Ellipse, G, Path, Rect } from "react-native-svg";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import type { ThemeColors } from "../theme";
import type { DrawingFileItem, SortMode } from "../types";
import { FileCard } from "../components/FileCard";
import { isNativeICloudModuleAvailable } from "../../modules/icloud-files";

interface Props {
  files: DrawingFileItem[];
  favorites: Set<string>;
  recents: string[];
  sort: SortMode;
  refreshing: boolean;
  openingId: string | null;
  theme: ThemeColors;
  lang: EffectiveLang;
  onRefresh: () => void;
  onOpenFile: (item: DrawingFileItem) => void;
  onToggleStar: (id: string) => void;
  onPickSingleFile: () => void;
  onConnectICloudFolder: () => void;
  onChangeSort: (mode: SortMode) => void;
}

type FilterTab = "all" | "starred" | "recent";

function BrandMark({ theme }: { theme: ThemeColors }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Rect x={1.5} y={1.5} width={21} height={21} rx={6} fill={theme.logoTile} stroke={theme.border} strokeWidth={0.8} />
      <G fill={theme.logoFill} stroke={theme.text} strokeWidth={1.1} strokeLinejoin="round">
        <Rect x={6.35} y={5} width={3.1} height={13.7} />
        <Rect x={9.45} y={5} width={8} height={3.2} />
        <Path d="M9.25 11.7 L13.05 10.05 L16.95 11.7 L13.05 13.35 Z" />
        <Ellipse cx={13.55} cy={16.95} rx={4.1} ry={1.8} />
      </G>
    </Svg>
  );
}

export function FilesScreen({
  files,
  favorites,
  recents,
  sort,
  refreshing,
  openingId,
  theme,
  lang,
  onRefresh,
  onOpenFile,
  onToggleStar,
  onPickSingleFile,
  onConnectICloudFolder,
  onChangeSort,
}: Props) {
  const t = (k: I18nKey, vars?: Record<string, string | number>) => translate(lang, k, vars);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterTab>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = files.filter((f) => {
      if (filter === "starred" && !favorites.has(f.id)) return false;
      if (filter === "recent" && !recents.includes(f.id)) return false;
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        f.folderName.toLowerCase().includes(q) ||
        (f.searchText?.toLowerCase().includes(q) ?? false)
      );
    });

    if (filter === "recent") {
      const rank = new Map(recents.map((id, i) => [id, i]));
      list = [...list].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
    } else if (sort === "name") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, lang === "zh" ? "zh-CN" : "en"));
    } else {
      list = [...list].sort((a, b) => b.mtime - a.mtime);
    }
    return list;
  }, [files, favorites, recents, query, filter, sort, lang]);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <BrandMark theme={theme} />
          <Text style={[styles.title, { color: theme.text }]}>{t("files.title")}</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => onChangeSort(sort === "mtime" ? "name" : "mtime")}
            style={[styles.ghostBtn, { borderColor: theme.border, backgroundColor: theme.surface }]}
          >
            <Text style={[styles.ghostText, { color: theme.muted }]}>
              {sort === "mtime" ? t("files.sortMtime") : t("files.sortName")}
            </Text>
          </Pressable>
          <Pressable
            onPress={isNativeICloudModuleAvailable ? onConnectICloudFolder : onPickSingleFile}
            style={({ pressed }) => [
              styles.openBtn,
              { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={[styles.openBtnText, { color: theme.accentText }]}>
              {isNativeICloudModuleAvailable ? `+ ${t("files.connectICloud")}` : t("files.pickFile")}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.searchBox, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={{ color: theme.muted, fontSize: 14 }}>⌕</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("files.searchPlaceholder")}
          placeholderTextColor={theme.muted}
          style={[styles.searchInput, { color: theme.text }]}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      <View style={[styles.segmented, { backgroundColor: theme.accentSoft }]}>
        {(["all", "starred", "recent"] as FilterTab[]).map((tab) => {
          const active = filter === tab;
          const label =
            tab === "all" ? t("files.filterAll") : tab === "starred" ? t("files.filterStarred") : t("files.filterRecent");
          return (
            <Pressable
              key={tab}
              onPress={() => setFilter(tab)}
              style={[styles.segBtn, active && { backgroundColor: theme.surface }]}
            >
              <Text style={[styles.segText, { color: active ? theme.text : theme.muted }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.muted} />}
        renderItem={({ item }) => (
          <View>
            <FileCard
              item={item}
              starred={favorites.has(item.id)}
              theme={theme}
              lang={lang}
              onPress={() => onOpenFile(item)}
              onToggleStar={() => onToggleStar(item.id)}
            />
            {openingId === item.id && (
              <View style={styles.downloadingOverlay}>
                <ActivityIndicator size="small" color={theme.text} />
                <Text style={[styles.downloadingText, { color: theme.muted }]}>{t("files.downloading")}</Text>
              </View>
            )}
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>{t("files.empty")}</Text>
            <Text style={[styles.emptyHint, { color: theme.muted }]}>{t("files.emptyHint")}</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 14,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 10,
    paddingBottom: 10,
    gap: 8,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  ghostBtn: {
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
  },
  ghostText: {
    fontSize: 12,
    fontWeight: "500",
  },
  openBtn: {
    height: 28,
    paddingHorizontal: 11,
    borderRadius: 7,
    justifyContent: "center",
  },
  openBtnText: {
    fontSize: 12,
    fontWeight: "500",
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    height: 36,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    gap: 7,
    marginBottom: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
  },
  segmented: {
    flexDirection: "row",
    padding: 2,
    borderRadius: 8,
    marginBottom: 12,
  },
  segBtn: {
    flex: 1,
    height: 28,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  segText: {
    fontSize: 12.5,
    fontWeight: "500",
  },
  listContent: {
    paddingBottom: 24,
  },
  downloadingOverlay: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingBottom: 10,
  },
  downloadingText: {
    fontSize: 12,
  },
  emptyBox: {
    paddingTop: 48,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 6,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "600",
  },
  emptyHint: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
});
