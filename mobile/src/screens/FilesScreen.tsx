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
        <Text style={[styles.title, { color: theme.text }]}>{t("files.title")}</Text>
        <Pressable
          onPress={() => onChangeSort(sort === "mtime" ? "name" : "mtime")}
          style={[styles.sortPill, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
          <Text style={[styles.sortText, { color: theme.muted }]}>
            {sort === "mtime" ? t("files.sortMtime") : t("files.sortName")}
          </Text>
        </Pressable>
      </View>

      <View style={[styles.searchBox, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={{ color: theme.muted, fontSize: 15 }}>⌕</Text>
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

      <View style={styles.actionRow}>
        {isNativeICloudModuleAvailable && (
          <Pressable
            onPress={onConnectICloudFolder}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={styles.actionBtnPrimaryText}>☁ {t("files.connectICloud")}</Text>
          </Pressable>
        )}
        <Pressable
          onPress={onPickSingleFile}
          style={({ pressed }) => [
            styles.actionBtn,
            isNativeICloudModuleAvailable
              ? { backgroundColor: theme.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border }
              : { backgroundColor: theme.accent },
            { opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text style={isNativeICloudModuleAvailable ? [styles.actionBtnText, { color: theme.text }] : styles.actionBtnPrimaryText}>
            {isNativeICloudModuleAvailable ? t("files.pickFile") : `☁ ${t("files.pickFile")}`}
          </Text>
        </Pressable>
      </View>

      {!isNativeICloudModuleAvailable && (
        <View style={[styles.hintBanner, { backgroundColor: theme.accentSoft }]}>
          <Text style={[styles.hintText, { color: theme.accent }]}>{t("files.expoGoHint")}</Text>
        </View>
      )}

      <View style={styles.filterRow}>
        {(["all", "starred", "recent"] as FilterTab[]).map((tab) => {
          const active = filter === tab;
          const label =
            tab === "all" ? t("files.filterAll") : tab === "starred" ? t("files.filterStarred") : t("files.filterRecent");
          return (
            <Pressable
              key={tab}
              onPress={() => setFilter(tab)}
              style={[
                styles.filterChip,
                {
                  backgroundColor: active ? theme.text : theme.surface,
                  borderColor: active ? theme.text : theme.border,
                },
              ]}
            >
              <Text style={[styles.filterText, { color: active ? theme.bg : theme.muted }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
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
              <View style={[styles.openingOverlay, { backgroundColor: theme.hudBg }]}>
                <ActivityIndicator size="small" color={theme.accent} />
                <Text style={[styles.openingText, { color: theme.text }]}>{t("files.downloading")}</Text>
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
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
    paddingBottom: 10,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  sortPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sortText: {
    fontSize: 12,
    fontWeight: "600",
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 6,
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  actionBtn: {
    flex: 1,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  actionBtnPrimaryText: {
    color: "#ffffff",
    fontSize: 13.5,
    fontWeight: "600",
  },
  actionBtnText: {
    fontSize: 13.5,
    fontWeight: "600",
  },
  hintBanner: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginBottom: 10,
  },
  hintText: {
    fontSize: 12,
    lineHeight: 17,
  },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  filterText: {
    fontSize: 12.5,
    fontWeight: "600",
  },
  listContent: {
    paddingBottom: 24,
  },
  openingOverlay: {
    ...StyleSheet.absoluteFillObject,
    bottom: 10,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  openingText: {
    fontSize: 13,
    fontWeight: "600",
  },
  emptyBox: {
    alignItems: "center",
    paddingTop: 64,
    paddingHorizontal: 24,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "600",
  },
  emptyHint: {
    fontSize: 13.5,
    textAlign: "center",
    lineHeight: 20,
  },
});
