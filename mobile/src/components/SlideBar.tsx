import { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import type { SlideInfo } from "../lib/excalidraw";
import type { ThemeColors } from "../theme";
import { hapticSelection, NativeBlur, NativeIcon } from "./NativeUI";

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
  const goPrev = () => {
    hapticSelection();
    onSelectSlide(activeIndex <= 0 ? slides.length - 1 : activeIndex - 1);
  };
  const goNext = () => {
    hapticSelection();
    onSelectSlide(activeIndex < 0 ? 0 : (activeIndex + 1) % slides.length);
  };

  return (
    <>
      <NativeBlur dark={theme.dark} style={[styles.pill, { borderColor: theme.border }]}>
        <Pressable style={styles.btn} onPress={goPrev} hitSlop={6} accessibilityLabel="Previous slide">
          <NativeIcon name="chevron.left" size={15} color={theme.text} weight="semibold" />
        </Pressable>

        <Pressable
          style={styles.labelBtn}
          onPress={() => {
            hapticSelection();
            onSelectSlide(activeIndex < 0 ? 0 : -1);
          }}
        >
          <Text style={[styles.label, { color: theme.text }]}>
            {activeIndex >= 0 ? `${activeIndex + 1} / ${slides.length}` : `${t("viewer.slides")} (${slides.length})`}
          </Text>
        </Pressable>

        <Pressable style={styles.btn} onPress={goNext} hitSlop={6} accessibilityLabel="Next slide">
          <NativeIcon name="chevron.right" size={15} color={theme.text} weight="semibold" />
        </Pressable>

        {current && (
          <Pressable
            style={[styles.notesBtn, { borderLeftColor: theme.separator }]}
            onPress={() => {
              hapticSelection();
              setNotesOpen(true);
            }}
            hitSlop={6}
          >
            <NativeIcon name="doc.text" size={13} color={current.notesText ? theme.text : theme.muted} />
            <Text style={[styles.notesLabel, { color: current.notesText ? theme.text : theme.muted }]}>
              {t("viewer.notes")}
            </Text>
          </Pressable>
        )}
      </NativeBlur>

      <Modal
        visible={notesOpen}
        transparent={Platform.OS !== "ios"}
        presentationStyle={Platform.OS === "ios" ? "pageSheet" : "overFullScreen"}
        animationType="slide"
        onRequestClose={() => setNotesOpen(false)}
      >
        {Platform.OS === "ios" ? (
          <View style={[styles.nativeSheet, { backgroundColor: theme.bg }]}>
            <View style={styles.grabberWrap}>
              <View style={[styles.grabber, { backgroundColor: theme.separator }]} />
            </View>
            <View style={[styles.sheetHead, { borderBottomColor: theme.separator }]}>
              <Text style={[styles.sheetTitle, { color: theme.text }]} numberOfLines={1}>
                {current ? `${activeIndex + 1}. ${current.name}` : t("viewer.notes")}
              </Text>
              <Pressable onPress={() => setNotesOpen(false)} hitSlop={8}>
                <Text style={{ color: theme.text, fontWeight: "600", fontSize: 16 }}>{t("common.done")}</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.sheetBody} contentContainerStyle={styles.sheetBodyContent}>
              <Text style={[styles.notesText, { color: current?.notesText ? theme.text : theme.muted }]}>
                {current?.notesText || t("viewer.noNotes")}
              </Text>
            </ScrollView>
          </View>
        ) : (
          <Pressable style={styles.backdrop} onPress={() => setNotesOpen(false)}>
            <Pressable style={[styles.sheet, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => {}}>
              <View style={styles.grabberWrap}>
                <View style={[styles.grabber, { backgroundColor: theme.separator }]} />
              </View>
              <View style={styles.sheetHead}>
                <Text style={[styles.sheetTitle, { color: theme.text }]} numberOfLines={1}>
                  {current ? `${activeIndex + 1}. ${current.name}` : t("viewer.notes")}
                </Text>
                <Pressable onPress={() => setNotesOpen(false)} hitSlop={8}>
                  <Text style={{ color: theme.text, fontWeight: "600", fontSize: 15 }}>{t("common.done")}</Text>
                </Pressable>
              </View>
              <ScrollView style={styles.sheetBody}>
                <Text style={[styles.notesText, { color: current?.notesText ? theme.text : theme.muted }]}>
                  {current?.notesText || t("viewer.noNotes")}
                </Text>
              </ScrollView>
            </Pressable>
          </Pressable>
        )}
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
    height: 36,
    overflow: "hidden",
  },
  btn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  labelBtn: {
    paddingHorizontal: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  notesBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderLeftWidth: StyleSheet.hairlineWidth,
    paddingLeft: 10,
    paddingRight: 8,
    marginLeft: 4,
  },
  notesLabel: {
    fontSize: 12.5,
    fontWeight: "500",
  },
  nativeSheet: {
    flex: 1,
  },
  grabberWrap: {
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 4,
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingBottom: 28,
    maxHeight: "62%",
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "transparent",
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
    marginRight: 12,
  },
  sheetBody: {
    flexGrow: 0,
  },
  sheetBodyContent: {
    padding: 18,
  },
  notesText: {
    fontSize: 15.5,
    lineHeight: 24,
  },
});
