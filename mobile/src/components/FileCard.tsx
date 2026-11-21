import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import type { ThemeColors } from "../theme";
import type { DrawingFileItem } from "../types";
import { SceneThumbnail } from "./SceneThumbnail";

interface Props {
  item: DrawingFileItem;
  starred: boolean;
  theme: ThemeColors;
  lang: EffectiveLang;
  onPress: () => void;
  onToggleStar: () => void;
}

function formatDate(ts: number, lang: EffectiveLang): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric" });
}

export const FileCard = React.memo(function FileCard({ item, starred, theme, lang, onPress, onToggleStar }: Props) {
  const t = (k: I18nKey, vars?: Record<string, string | number>) => translate(lang, k, vars);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: theme.card,
          borderColor: theme.border,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <SceneThumbnail rawJson={item.rawJson} theme={theme} />

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
            {item.name}
          </Text>
          {item.source === "sample" && (
            <View style={[styles.badge, { backgroundColor: theme.accentSoft }]}>
              <Text style={[styles.badgeText, { color: theme.accent }]}>{t("files.sampleTag")}</Text>
            </View>
          )}
          {item.isUbiquitous && !item.downloaded && (
            <View style={[styles.badge, { backgroundColor: theme.accentSoft }]}>
              <Text style={[styles.badgeText, { color: theme.accent }]}>☁ {t("files.cloudOnly")}</Text>
            </View>
          )}
        </View>

        <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>
          {[
            item.folderName,
            item.elementCount !== undefined ? t("files.elements", { n: item.elementCount }) : null,
            item.slideCount ? t("files.slides", { n: item.slideCount }) : null,
            formatDate(item.mtime, lang),
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>

      <Pressable
        onPress={(e) => {
          e.stopPropagation();
          onToggleStar();
        }}
        hitSlop={10}
        style={styles.starBtn}
      >
        <Text style={{ fontSize: 18, color: starred ? "#f59f00" : theme.muted }}>{starred ? "★" : "☆"}</Text>
      </Pressable>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
    gap: 12,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  name: {
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
  },
  meta: {
    fontSize: 12,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "600",
  },
  starBtn: {
    padding: 6,
  },
});
