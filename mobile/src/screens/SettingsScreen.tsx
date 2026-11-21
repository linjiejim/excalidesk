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
    <View style={[styles.segmented, { backgroundColor: theme.bg, borderColor: theme.border }]}>
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
              <Text style={[styles.folderName, { color: theme.text }]}>
                {f.isICloud ? "☁ " : "📁 "}
                {f.name}
              </Text>
              <Pressable onPress={() => onRemoveFolder(f.id)}>
                <Text style={{ color: theme.danger, fontSize: 13, fontWeight: "600" }}>{t("settings.remove")}</Text>
              </Pressable>
            </View>
          ))
        )}

        {isNativeICloudModuleAvailable && (
          <Pressable onPress={onAddFolder} style={[styles.outlineBtn, { borderColor: theme.border }]}>
            <Text style={{ color: theme.accent, fontWeight: "600" }}>+ {t("settings.addFolder")}</Text>
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
        <Text style={[styles.hint, { color: theme.muted }]}>{t("settings.serverHint")}</Text>
      </View>

      <Pressable
        onPress={() => {
          onClearCache();
          Alert.alert(t("settings.title"), t("settings.cacheCleared"));
        }}
        style={[styles.dangerBtn, { backgroundColor: theme.surface, borderColor: theme.border }]}
      >
        <Text style={{ color: theme.danger, fontWeight: "600", fontSize: 15 }}>{t("settings.clearCache")}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
    paddingTop: 8,
    paddingBottom: 14,
  },
  card: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 10,
    marginBottom: 14,
  },
  label: {
    fontSize: 15,
    fontWeight: "600",
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
  },
  muted: {
    fontSize: 13,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
  },
  segmented: {
    flexDirection: "row",
    padding: 3,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segBtn: {
    flex: 1,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  segText: {
    fontSize: 13,
    fontWeight: "600",
  },
  folderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  folderName: {
    fontSize: 14,
    fontWeight: "500",
  },
  outlineBtn: {
    height: 38,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  input: {
    height: 40,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  dangerBtn: {
    height: 44,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
  },
});
