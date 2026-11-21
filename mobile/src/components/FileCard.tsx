import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import type { ThemeColors } from "../theme";
import type { DrawingFileItem } from "../types";
import { hapticSelection, NativeIcon } from "./NativeUI";
import { SceneThumbnail } from "./SceneThumbnail";

interface Props {
  item: DrawingFileItem;
  starred: boolean;
  isLast: boolean;
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

export const FileCard = React.memo(function FileCard({
  item,
  starred,
  isLast,
  theme,
  lang,
  onPress,
  onToggleStar,
}: Props) {
  const t = (k: I18nKey, vars?: Record<string, string | number>) => translate(lang, k, vars);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.pressed : "transparent" },
      ]}
    >
      <SceneThumbnail rawJson={item.rawJson} theme={theme} width={56} height={42} />

      <View style={[styles.rightWrap, !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.separator }]}>
        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
              {item.name}
            </Text>
            {item.isUbiquitous && !item.downloaded && (
              <NativeIcon name="icloud.and.arrow.down" size={14} color={theme.muted} />
            )}
          </View>

          <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>
            {[
              item.source === "sample" ? t("files.sampleTag") : item.folderName,
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
            hapticSelection();
            onToggleStar();
          }}
          hitSlop={10}
          style={styles.starBtn}
          accessibilityLabel={starred ? "Unstar" : "Star"}
        >
          <NativeIcon
            name={starred ? "star.fill" : "star"}
            size={16}
            color={starred ? theme.text : theme.muted}
          />
        </Pressable>

        <NativeIcon name="chevron.right" size={13} color={theme.muted} weight="semibold" />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 12,
    gap: 11,
  },
  rightWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingRight: 12,
    gap: 8,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  name: {
    fontSize: 15,
    fontWeight: "500",
    flexShrink: 1,
  },
  meta: {
    fontSize: 12.5,
  },
  starBtn: {
    padding: 4,
  },
});
