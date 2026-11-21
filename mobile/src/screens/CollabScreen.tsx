import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import { parseMobileCollabLink } from "../lib/collabLinks";
import type { ThemeColors } from "../theme";
import type { RecentCollabLink } from "../types";
import { GroupedSection, hapticSelection, NativeIcon } from "../components/NativeUI";

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
    hapticSelection();
    setError("");
    onOpenCollabUrl(input.trim());
    setInput("");
  };

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.bg }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
    >
      <GroupedSection theme={theme} footer={error || t("collab.e2ee")}>
        <View style={styles.inputRow}>
          <NativeIcon name="link" size={16} color={theme.muted} />
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
            clearButtonMode="while-editing"
            style={[styles.input, { color: theme.text }]}
            returnKeyType="go"
            onSubmitEditing={submit}
          />
        </View>
        <View style={[styles.hairline, { backgroundColor: theme.separator }]} />
        <Pressable
          onPress={submit}
          style={({ pressed }) => [
            styles.actionRow,
            { backgroundColor: pressed ? theme.pressed : "transparent" },
          ]}
        >
          <Text style={[styles.actionText, { color: input.trim() ? theme.text : theme.muted }]}>
            {t("collab.open")}
          </Text>
        </Pressable>
      </GroupedSection>

      {recentLinks.length > 0 && (
        <GroupedSection header={t("collab.recent")} theme={theme}>
          {recentLinks.map((item, idx) => (
            <Pressable
              key={item.id}
              onPress={() => onOpenCollabUrl(item.url)}
              style={({ pressed }) => [
                styles.linkRow,
                { backgroundColor: pressed ? theme.pressed : "transparent" },
              ]}
            >
              <View
                style={[
                  styles.linkInner,
                  idx < recentLinks.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: theme.separator,
                  },
                ]}
              >
                <View style={styles.linkBody}>
                  <View style={styles.linkTop}>
                    {item.kind === "room" && <View style={[styles.dot, { backgroundColor: theme.live }]} />}
                    <Text style={[styles.linkTitle, { color: theme.text }]} numberOfLines={1}>
                      {item.title}
                    </Text>
                  </View>
                  <Text style={[styles.linkUrl, { color: theme.muted }]} numberOfLines={1}>
                    {item.url}
                  </Text>
                </View>
                <NativeIcon name="chevron.right" size={13} color={theme.muted} weight="semibold" />
              </View>
            </Pressable>
          ))}
        </GroupedSection>
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
    paddingTop: 12,
    paddingBottom: 32,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    height: 46,
    gap: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 14,
  },
  actionRow: {
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    fontSize: 16,
    fontWeight: "600",
  },
  linkRow: {
    paddingLeft: 14,
  },
  linkInner: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    paddingRight: 14,
    gap: 10,
  },
  linkBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  linkTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  linkTitle: {
    fontSize: 15,
    fontWeight: "500",
    flex: 1,
  },
  linkUrl: {
    fontSize: 12.5,
  },
});
