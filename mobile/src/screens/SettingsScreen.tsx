import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { SavedICloudFolder } from "../../modules/icloud-files";
import { isNativeICloudModuleAvailable } from "../../modules/icloud-files";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import type { ThemeColors } from "../theme";
import type { LangSetting, MobileSettings, ThemeSetting } from "../types";
import { GroupedSection, NativeIcon, NativeSegmented, showNativeActionSheet } from "../components/NativeUI";

interface Props {
  settings: MobileSettings;
  folders: SavedICloudFolder[];
  theme: ThemeColors;
  lang: EffectiveLang;
  onUpdateSettings: (patch: Partial<MobileSettings>) => void;
  onAddFolder: () => void;
  onRemoveFolder: (id: string) => void;
  onClearCache: () => void;
}

export function SettingsScreen({
  settings,
  folders,
  theme,
  lang,
  onUpdateSettings,
  onAddFolder,
  onRemoveFolder,
  onClearCache,
}: Props) {
  const t = (k: I18nKey) => translate(lang, k);

  const confirmRemoveFolder = (f: SavedICloudFolder) => {
    showNativeActionSheet({
      title: f.name,
      cancelLabel: t("common.cancel"),
      items: [{ label: t("settings.remove"), destructive: true, onPress: () => onRemoveFolder(f.id) }],
    });
  };

  const confirmClearCache = () => {
    showNativeActionSheet({
      title: t("settings.clearCache"),
      cancelLabel: t("common.cancel"),
      items: [{ label: t("settings.clearCache"), destructive: true, onPress: onClearCache }],
    });
  };

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: theme.bg }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
    >
      <GroupedSection header={t("settings.appearance")} theme={theme}>
        <View style={styles.segmentRow}>
          <NativeSegmented<ThemeSetting>
            value={settings.theme}
            theme={theme}
            onChange={(v) => onUpdateSettings({ theme: v })}
            options={[
              ["system", t("settings.system")],
              ["light", t("settings.light")],
              ["dark", t("settings.dark")],
            ]}
          />
        </View>
      </GroupedSection>

      <GroupedSection header={t("settings.language")} theme={theme}>
        <View style={styles.segmentRow}>
          <NativeSegmented<LangSetting>
            value={settings.lang}
            theme={theme}
            onChange={(v) => onUpdateSettings({ lang: v })}
            options={[
              ["system", t("settings.system")],
              ["zh", "简体中文"],
              ["en", "English"],
            ]}
          />
        </View>
      </GroupedSection>

      <GroupedSection
        header={t("settings.icloudFolders")}
        footer={isNativeICloudModuleAvailable ? t("settings.nativeActive") : t("settings.nativeFallback")}
        theme={theme}
      >
        {folders.length === 0 ? (
          <View style={styles.row}>
            <Text style={[styles.muted, { color: theme.muted }]}>{t("settings.noFolders")}</Text>
          </View>
        ) : (
          folders.map((f, idx) => (
            <Pressable
              key={f.id}
              onPress={() => confirmRemoveFolder(f)}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.pressed : "transparent" },
                (idx < folders.length - 1 || isNativeICloudModuleAvailable) && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: theme.separator,
                },
              ]}
            >
              <View style={styles.rowLeft}>
                <NativeIcon name={f.isICloud ? "icloud" : "folder"} size={17} color={theme.muted} />
                <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                  {f.name}
                </Text>
              </View>
              <Text style={{ color: theme.danger, fontSize: 14 }}>{t("settings.remove")}</Text>
            </Pressable>
          ))
        )}

        {isNativeICloudModuleAvailable && (
          <Pressable
            onPress={onAddFolder}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.pressed : "transparent" }]}
          >
            <View style={styles.rowLeft}>
              <NativeIcon name="plus" size={16} color={theme.text} weight="medium" />
              <Text style={[styles.rowTitle, { color: theme.text }]}>{t("settings.addFolder")}</Text>
            </View>
          </Pressable>
        )}
      </GroupedSection>

      <GroupedSection header={t("settings.server")} theme={theme}>
        <View style={styles.inputWrap}>
          <TextInput
            value={settings.collabServer}
            onChangeText={(collabServer) => onUpdateSettings({ collabServer })}
            placeholder="http://localhost:3456"
            placeholderTextColor={theme.muted}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={[styles.input, { color: theme.text }]}
          />
        </View>
      </GroupedSection>

      <GroupedSection theme={theme}>
        <Pressable
          onPress={confirmClearCache}
          style={({ pressed }) => [styles.centerRow, { backgroundColor: pressed ? theme.pressed : "transparent" }]}
        >
          <Text style={{ color: theme.danger, fontSize: 16 }}>{t("settings.clearCache")}</Text>
        </Pressable>
      </GroupedSection>
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
    paddingBottom: 36,
  },
  segmentRow: {
    padding: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 44,
    paddingHorizontal: 14,
    gap: 10,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontSize: 15.5,
    flexShrink: 1,
  },
  muted: {
    fontSize: 14.5,
  },
  inputWrap: {
    paddingHorizontal: 14,
    height: 44,
    justifyContent: "center",
  },
  input: {
    fontSize: 15,
    paddingVertical: 0,
  },
  centerRow: {
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
