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
          <Text style={[styles.primaryBtnText, { color: theme.accentText }]}>{t("collab.open")}</Text>
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
              <View style={[styles.badge, { backgroundColor: theme.accentSoft }]}>
                <Text style={[styles.badgeText, { color: item.kind === "room" ? theme.live : theme.muted }]}>
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
    paddingHorizontal: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: -0.3,
    paddingTop: 12,
    paddingBottom: 12,
  },
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 8,
    marginBottom: 18,
  },
  input: {
    height: 38,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    fontSize: 13.5,
  },
  err: {
    fontSize: 12,
  },
  primaryBtn: {
    height: 38,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    fontSize: 14,
    fontWeight: "500",
  },
  e2ee: {
    fontSize: 11.5,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontWeight: "600",
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  linkRow: {
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
    gap: 3,
  },
  linkTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  linkTitle: {
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
  },
  linkUrl: {
    fontSize: 11.5,
  },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "500",
  },
  empty: {
    fontSize: 12.5,
    paddingHorizontal: 2,
  },
});
