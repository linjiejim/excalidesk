import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import type { SlideInfo } from "../lib/excalidraw";
import type { ThemeColors } from "../theme";

interface Props {
  slides: SlideInfo[];
  activeIndex: number;
  theme: ThemeColors;
  lang: EffectiveLang;
  onSelectSlide: (idx: number) => void;
}

export function SlideBar({ slides, activeIndex, theme, lang, onSelectSlide }: Props) {
  const [notesOpen, setNotesOpen] = useState(false);
  const t = (k: I18nKey) => translate(lang, k);
  if (!slides.length) return null;

  const current = activeIndex >= 0 ? slides[activeIndex] : null;
  const goPrev = () => onSelectSlide(activeIndex <= 0 ? slides.length - 1 : activeIndex - 1);
  const goNext = () => onSelectSlide(activeIndex < 0 ? 0 : (activeIndex + 1) % slides.length);

  return (
    <>
      <View style={[styles.pill, { backgroundColor: theme.hudBg, borderColor: theme.border }]}>
        <Pressable style={styles.btn} onPress={goPrev} hitSlop={6}>
          <Text style={[styles.arrow, { color: theme.text }]}>‹</Text>
        </Pressable>

        <Pressable style={styles.labelBtn} onPress={() => onSelectSlide(activeIndex < 0 ? 0 : -1)}>
          <Text style={[styles.label, { color: theme.text }]}>
            {activeIndex >= 0 ? `${activeIndex + 1} / ${slides.length}` : `${t("viewer.slides")} (${slides.length})`}
          </Text>
        </Pressable>

        <Pressable style={styles.btn} onPress={goNext} hitSlop={6}>
          <Text style={[styles.arrow, { color: theme.text }]}>›</Text>
        </Pressable>

        {current && (
          <Pressable
            style={[styles.notesBtn, { borderLeftColor: theme.border }]}
            onPress={() => setNotesOpen(true)}
            hitSlop={6}
          >
            <Text style={[styles.notesLabel, { color: current.notesText ? theme.accent : theme.muted }]}>
              {t("viewer.notes")}
            </Text>
          </Pressable>
        )}
      </View>

      <Modal visible={notesOpen} transparent animationType="slide" onRequestClose={() => setNotesOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setNotesOpen(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => {}}>
            <View style={styles.sheetHead}>
              <Text style={[styles.sheetTitle, { color: theme.text }]} numberOfLines={1}>
                {current ? `${activeIndex + 1}. ${current.name}` : t("viewer.notes")}
              </Text>
              <Pressable onPress={() => setNotesOpen(false)}>
                <Text style={{ color: theme.accent, fontWeight: "600", fontSize: 15 }}>{t("common.done")}</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.sheetBody}>
              <Text style={[styles.notesText, { color: current?.notesText ? theme.text : theme.muted }]}>
                {current?.notesText || t("viewer.noNotes")}
              </Text>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    height: 38,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  btn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  arrow: {
    fontSize: 22,
    lineHeight: 24,
    fontWeight: "500",
  },
  labelBtn: {
    paddingHorizontal: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
  },
  notesBtn: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    paddingLeft: 10,
    paddingRight: 8,
    marginLeft: 4,
  },
  notesLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  sheet: {
    maxHeight: "55%",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
    gap: 12,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: "700",
    flex: 1,
  },
  sheetBody: {
    maxHeight: 280,
  },
  notesText: {
    fontSize: 16,
    lineHeight: 24,
  },
});
