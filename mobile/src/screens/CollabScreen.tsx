import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import { parseMobileCollabLink } from "../lib/collabLinks";
import type { ThemeColors } from "../theme";
import type { RecentCollabLink } from "../types";

interface Props {
  recentLinks: RecentCollabLink[];
  theme: ThemeColors;
  lang: EffectiveLang;
  onOpenCollabUrl: (url: string) => void;
}

export function CollabScreen({ recentLinks, theme, lang, onOpenCollabUrl }: Props) {
  const t = (k: I18nKey) => translate(lang, k);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  const submit = () => {
    const parsed = parseMobileCollabLink(input);
    if (!parsed) {
      setError(t("collab.invalid"));
      return;
    }
    setError("");
    onOpenCollabUrl(input.trim());
    setInput("");
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Text style={[styles.title, { color: theme.text }]}>{t("collab.title")}</Text>
      <Text style={[styles.desc, { color: theme.muted }]}>{t("collab.desc")}</Text>

      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <TextInput
          value={input}
          onChangeText={(v) => {
            setInput(v);
            if (error) setError("");
          }}
          placeholder={t("collab.placeholder")}
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bg }]}
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        {!!error && <Text style={[styles.err, { color: theme.danger }]}>{error}</Text>}
        <Pressable
          onPress={submit}
          style={({ pressed }) => [styles.primaryBtn, { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text style={styles.primaryBtnText}>{t("collab.open")}</Text>
        </Pressable>
        <Text style={[styles.e2ee, { color: theme.muted }]}>{t("collab.e2ee")}</Text>
      </View>

      <Text style={[styles.sectionTitle, { color: theme.muted }]}>{t("collab.recent")}</Text>

      <FlatList
        data={recentLinks}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onOpenCollabUrl(item.url)}
            style={({ pressed }) => [
              styles.linkRow,
              { backgroundColor: theme.surface, borderColor: theme.border, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <View style={styles.linkTop}>
              <Text style={[styles.linkTitle, { color: theme.text }]} numberOfLines={1}>
                {item.title}
              </Text>
              <View
                style={[
                  styles.badge,
                  { backgroundColor: item.kind === "room" ? "rgba(47,158,68,0.14)" : theme.accentSoft },
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    { color: item.kind === "room" ? theme.live : theme.accent },
                  ]}
                >
                  {item.kind === "room" ? t("collab.roomBadge") : t("collab.shareBadge")}
                </Text>
              </View>
            </View>
            <Text style={[styles.linkUrl, { color: theme.muted }]} numberOfLines={1}>
              {item.url}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.muted }]}>{t("collab.recentEmpty")}</Text>
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
  title: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
    paddingTop: 8,
    paddingBottom: 6,
  },
  desc: {
    fontSize: 13.5,
    lineHeight: 19,
    marginBottom: 14,
  },
  card: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 10,
    marginBottom: 20,
  },
  input: {
    height: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  err: {
    fontSize: 12.5,
  },
  primaryBtn: {
    height: 42,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "600",
  },
  e2ee: {
    fontSize: 11.5,
    lineHeight: 16,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  linkRow: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 8,
    gap: 4,
  },
  linkTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  linkTitle: {
    fontSize: 14.5,
    fontWeight: "600",
    flex: 1,
  },
  linkUrl: {
    fontSize: 11.5,
  },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 10.5,
    fontWeight: "600",
  },
  empty: {
    fontSize: 13.5,
    paddingTop: 12,
  },
});
