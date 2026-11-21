import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import type { ThemeColors } from "../theme";
import type { DrawingFileItem, SortMode } from "../types";
import { FileCard } from "../components/FileCard";
import { GroupedSection, NativeIcon, NativeSegmented } from "../components/NativeUI";

interface Props {
  files: DrawingFileItem[];
  favorites: Set<string>;
  recents: string[];
  sort: SortMode;
  searchQuery: string;
  onChangeSearch: (q: string) => void;
  refreshing: boolean;
  openingId: string | null;
  theme: ThemeColors;
  lang: EffectiveLang;
  onRefresh: () => void;
  onOpenFile: (item: DrawingFileItem) => void;
  onToggleStar: (id: string) => void;
}

type FilterTab = "all" | "starred" | "recent";

export function FilesScreen({
  files,
  favorites,
  recents,
  sort,
  searchQuery,
  onChangeSearch,
  refreshing,
  openingId,
  theme,
  lang,
  onRefresh,
  onOpenFile,
  onToggleStar,
}: Props) {
  const t = (k: I18nKey, vars?: Record<string, string | number>) => translate(lang, k, vars);
  const [filter, setFilter] = useState<FilterTab>("all");

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
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
  }, [files, favorites, recents, searchQuery, filter, sort, lang]);

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.bg }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.muted} />}
    >
      {/* On iOS, native UISearchBar lives in the UINavigationController header via headerSearchBarOptions. */}
      {Platform.OS !== "ios" && (
        <View style={[styles.searchBox, { backgroundColor: theme.accentSoft }]}>
          <NativeIcon name="magnifyingglass" size={15} color={theme.muted} />
          <TextInput
            value={searchQuery}
            onChangeText={onChangeSearch}
            placeholder={t("files.searchPlaceholder")}
            placeholderTextColor={theme.muted}
            style={[styles.searchInput, { color: theme.text }]}
            clearButtonMode="while-editing"
            returnKeyType="search"
          />
        </View>
      )}

      <View style={styles.segmentWrap}>
        <NativeSegmented<FilterTab>
          value={filter}
          theme={theme}
          onChange={setFilter}
          options={[
            ["all", t("files.filterAll")],
            ["starred", t("files.filterStarred")],
            ["recent", t("files.filterRecent")],
          ]}
        />
      </View>

      {filtered.length > 0 ? (
        <GroupedSection theme={theme}>
          {filtered.map((item, idx) => (
            <View key={item.id}>
              <FileCard
                item={item}
                starred={favorites.has(item.id)}
                isLast={idx === filtered.length - 1}
                theme={theme}
                lang={lang}
                onPress={() => onOpenFile(item)}
                onToggleStar={() => onToggleStar(item.id)}
              />
              {openingId === item.id && (
                <View style={styles.downloadingOverlay}>
                  <ActivityIndicator size="small" color={theme.muted} />
                  <Text style={[styles.downloadingText, { color: theme.muted }]}>{t("files.downloading")}</Text>
                </View>
              )}
            </View>
          ))}
        </GroupedSection>
      ) : (
        <View style={styles.emptyBox}>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>{t("files.empty")}</Text>
          <Text style={[styles.emptyHint, { color: theme.muted }]}>{t("files.emptyHint")}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 32,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    height: 36,
    borderRadius: 10,
    paddingHorizontal: 10,
    gap: 7,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  segmentWrap: {
    marginBottom: 14,
  },
  downloadingOverlay: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingBottom: 10,
  },
  downloadingText: {
    fontSize: 12.5,
  },
  emptyBox: {
    paddingTop: 64,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 6,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "600",
  },
  emptyHint: {
    fontSize: 13.5,
    textAlign: "center",
    lineHeight: 20,
  },
});
