import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { SavedICloudFolder } from "../../modules/icloud-files";
import { isNativeICloudModuleAvailable } from "../../modules/icloud-files";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import type { ThemeColors } from "../theme";
import type { LangSetting, MobileSettings, ThemeSetting } from "../types";

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

function Segmented<T extends string>({
  value,
  options,
  theme,
  onChange,
}: {
  value: T;
  options: [T, string][];
  theme: ThemeColors;
  onChange: (v: T) => void;
}) {
  return (
    <View style={[styles.segmented, { backgroundColor: theme.accentSoft }]}>
      {options.map(([v, label]) => {
        const active = v === value;
        return (
          <Pressable
            key={v}
            onPress={() => onChange(v)}
            style={[styles.segBtn, active && { backgroundColor: theme.surface }]}
          >
            <Text style={[styles.segText, { color: active ? theme.text : theme.muted }]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
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

  return (
    <ScrollView style={[styles.root, { backgroundColor: theme.bg }]} contentContainerStyle={styles.content}>
      <Text style={[styles.title, { color: theme.text }]}>{t("settings.title")}</Text>

      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={[styles.label, { color: theme.text }]}>{t("settings.appearance")}</Text>
        <Segmented<ThemeSetting>
          value={settings.theme}
          theme={theme}
          onChange={(v) => onUpdateSettings({ theme: v })}
          options={[
            ["system", t("settings.system")],
            ["light", t("settings.light")],
            ["dark", t("settings.dark")],
          ]}
        />

        <View style={[styles.divider, { backgroundColor: theme.border }]} />

        <Text style={[styles.label, { color: theme.text }]}>{t("settings.language")}</Text>
        <Segmented<LangSetting>
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

      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={[styles.label, { color: theme.text }]}>{t("settings.icloudFolders")}</Text>
        <Text style={[styles.hint, { color: isNativeICloudModuleAvailable ? theme.live : theme.muted }]}>
          {isNativeICloudModuleAvailable ? `● ${t("settings.nativeActive")}` : t("settings.nativeFallback")}
        </Text>

        {folders.length === 0 ? (
          <Text style={[styles.muted, { color: theme.muted }]}>{t("settings.noFolders")}</Text>
        ) : (
          folders.map((f) => (
            <View key={f.id} style={[styles.folderRow, { borderTopColor: theme.border }]}>
              <Text style={[styles.folderName, { color: theme.text }]}>{f.name}</Text>
              <Pressable onPress={() => onRemoveFolder(f.id)}>
                <Text style={{ color: theme.danger, fontSize: 12.5 }}>{t("settings.remove")}</Text>
              </Pressable>
            </View>
          ))
        )}

        {isNativeICloudModuleAvailable && (
          <Pressable onPress={onAddFolder} style={[styles.outlineBtn, { borderColor: theme.border }]}>
            <Text style={{ color: theme.text, fontWeight: "500", fontSize: 13 }}>+ {t("settings.addFolder")}</Text>
          </Pressable>
        )}
      </View>

      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={[styles.label, { color: theme.text }]}>{t("settings.server")}</Text>
        <TextInput
          value={settings.collabServer}
          onChangeText={(collabServer) => onUpdateSettings({ collabServer })}
          placeholder="http://localhost:3456"
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bg }]}
        />
      </View>

      <Pressable
        onPress={() => {
          onClearCache();
          Alert.alert(t("settings.title"), t("settings.cacheCleared"));
        }}
        style={[styles.dangerBtn, { backgroundColor: theme.surface, borderColor: theme.border }]}
      >
        <Text style={{ color: theme.danger, fontWeight: "500", fontSize: 14 }}>{t("settings.clearCache")}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 14,
    paddingBottom: 32,
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
    marginBottom: 12,
  },
  label: {
    fontSize: 13.5,
    fontWeight: "600",
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
  },
  muted: {
    fontSize: 12.5,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
  },
  segmented: {
    flexDirection: "row",
    padding: 2,
    borderRadius: 8,
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
  folderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  folderName: {
    fontSize: 13.5,
  },
  outlineBtn: {
    height: 34,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  input: {
    height: 36,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    fontSize: 13,
  },
  dangerBtn: {
    height: 40,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
});
