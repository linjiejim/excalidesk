import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { EffectiveLang, I18nKey } from "../i18n";
import { translate } from "../i18n";
import { parseMobileCollabLink } from "../lib/collabLinks";
import { parseExcalidrawJson, summarizeScene, type SlideInfo } from "../lib/excalidraw";
import { buildViewerHtml } from "../lib/viewerHtml";
import { DARK_THEME, LIGHT_THEME, type ThemeColors } from "../theme";
import type { ViewerTarget } from "../types";
import { SlideBar } from "../components/SlideBar";

interface Props {
  target: ViewerTarget;
  initialDark: boolean;
  lang: EffectiveLang;
  defaultServer: string;
  onClose: () => void;
}

export function ViewerScreen({ target, initialDark, lang, defaultServer, onClose }: Props) {
  const t = (k: I18nKey, vars?: Record<string, string | number>) => translate(lang, k, vars);
  const webRef = useRef<WebView>(null);

  const [dark, setDark] = useState(initialDark);
  const theme: ThemeColors = dark ? DARK_THEME : LIGHT_THEME;
  const [hudVisible, setHudVisible] = useState(true);
  const [zoomPct, setZoomPct] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(target.title);
  const [rawJson, setRawJson] = useState<string | undefined>(target.rawJson);
  const [peerCount, setPeerCount] = useState<number>(1);
  const [slideIdx, setSlideIdx] = useState(-1);

  const summary = useMemo(() => {
    if (!rawJson) return null;
    try {
      return summarizeScene(parseExcalidrawJson(rawJson));
    } catch {
      return null;
    }
  }, [rawJson]);

  const slides: SlideInfo[] = summary?.slides ?? [];
  const html = useMemo(() => buildViewerHtml({ dark: initialDark }), [initialDark]);

  const sendToWeb = useCallback((script: string) => {
    webRef.current?.injectJavaScript(`${script};true;`);
  }, []);

  const handleWebBoot = useCallback(() => {
    if (target.kind === "file" && target.rawJson) {
      sendToWeb(`window.__excalidesk.loadScene(${JSON.stringify(target.rawJson)})`);
      return;
    }
    if (target.kind === "collab" && target.collabUrl) {
      const parsed = parseMobileCollabLink(target.collabUrl);
      if (!parsed) {
        setError(t("collab.invalid"));
        setLoading(false);
        return;
      }
      const cfg = {
        kind: parsed.kind,
        id: parsed.id,
        key: parsed.key,
        serverUrl: parsed.serverUrl || defaultServer,
      };
      sendToWeb(`window.__excalidesk.openCollab(${JSON.stringify(cfg)})`);
    }
  }, [target, defaultServer, sendToWeb, t]);

  const onMessage = useCallback(
    (ev: WebViewMessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.nativeEvent.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "booted":
          handleWebBoot();
          break;
        case "ready":
          setLoading(false);
          break;
        case "tap":
          setHudVisible((v) => !v);
          break;
        case "zoom":
          if (typeof msg.zoom === "number") setZoomPct(Math.round(msg.zoom * 100));
          break;
        case "collab-status":
          if (typeof msg.peers === "number") setPeerCount(msg.peers);
          break;
        case "collab-peers-delta":
          setPeerCount((n) => Math.max(1, n + (msg.delta || 0)));
          break;
        case "collab-loaded":
          setLoading(false);
          if (msg.title) setTitle(msg.title);
          if (typeof msg.rawJson === "string") setRawJson(msg.rawJson);
          break;
        case "collab-error":
        case "error":
          setLoading(false);
          setError(String(msg.error || "Unknown error"));
          break;
      }
    },
    [handleWebBoot],
  );

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    sendToWeb(`window.__excalidesk.setTheme(${next ? "true" : "false"})`);
  };

  const fitScreen = () => {
    setSlideIdx(-1);
    sendToWeb("window.__excalidesk.fit()");
  };

  const selectSlide = (idx: number) => {
    if (idx < 0 || idx >= slides.length) {
      fitScreen();
      return;
    }
    setSlideIdx(idx);
    sendToWeb(`window.__excalidesk.focusBounds(${JSON.stringify(slides[idx].bounds)})`);
  };

  const shareDrawing = async () => {
    if (target.kind === "collab" && target.collabUrl) {
      await Share.share({ message: target.collabUrl, url: target.collabUrl });
      return;
    }
    if (!rawJson) return;
    try {
      const safeName = (title || "drawing").replace(/[\\/:*?"<>|]/g, "_");
      const outPath = `${FileSystem.cacheDirectory}${safeName}.excalidraw`;
      await FileSystem.writeAsStringAsync(outPath, rawJson, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(outPath, { mimeType: "application/json", UTI: "dev.excalidraw.drawing" });
      } else {
        await Share.share({ message: rawJson });
      }
    } catch (e) {
      Alert.alert(t("viewer.share"), String(e));
    }
  };

  const isLiveRoom = target.kind === "collab" && target.collabUrl?.includes("#room=");
  const subtitle = isLiveRoom
    ? `${t("viewer.live")} · ${t("viewer.peers", { n: peerCount })}`
    : summary
      ? `${t("files.elements", { n: summary.liveCount })}${summary.slideCount ? ` · ${t("files.slides", { n: summary.slideCount })}` : ""}`
      : t("viewer.readonly");

  return (
    <View style={[styles.root, { backgroundColor: dark ? "#121212" : "#ffffff" }]}>
      <WebView
        ref={webRef}
        source={{ html }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        bounces={false}
        onMessage={onMessage}
        style={styles.webview}
      />

      {loading && (
        <View style={[styles.overlayCenter, { backgroundColor: theme.bg }]} pointerEvents="none">
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.statusText, { color: theme.muted }]}>
            {target.kind === "collab" ? t("viewer.decrypting") : t("files.downloading")}
          </Text>
        </View>
      )}

      {error && (
        <View style={[styles.overlayCenter, { backgroundColor: theme.bg }]}>
          <Text style={[styles.errText, { color: theme.danger }]}>{t("viewer.error", { err: error })}</Text>
          <Pressable onPress={onClose} style={[styles.errBtn, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={{ color: theme.text, fontWeight: "600" }}>{t("common.close")}</Text>
          </Pressable>
        </View>
      )}

      {hudVisible && (
        <SafeAreaView style={styles.topHudWrap} edges={["top"]} pointerEvents="box-none">
          <View style={[styles.topBar, { backgroundColor: theme.hudBg, borderColor: theme.border }]}>
            <Pressable onPress={onClose} style={styles.iconBtn} hitSlop={8}>
              <Text style={[styles.backGlyph, { color: theme.text }]}>‹</Text>
            </Pressable>

            <View style={styles.titleBlock}>
              <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                {title}
              </Text>
              <View style={styles.subRow}>
                {isLiveRoom && <View style={[styles.liveDot, { backgroundColor: theme.live }]} />}
                <Text style={[styles.subtitle, { color: theme.muted }]} numberOfLines={1}>
                  {subtitle}
                </Text>
              </View>
            </View>

            <Pressable onPress={toggleTheme} style={styles.iconBtn} hitSlop={6}>
              <Text style={{ fontSize: 16, color: theme.text }}>{dark ? "☀" : "☾"}</Text>
            </Pressable>

            <Pressable onPress={() => void shareDrawing()} style={styles.shareBtn} hitSlop={6}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.accent }}>{t("viewer.share")}</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      )}

      {hudVisible && !loading && !error && (
        <SafeAreaView style={styles.bottomHudWrap} edges={["bottom"]} pointerEvents="box-none">
          <View style={styles.bottomRow} pointerEvents="box-none">
            <View style={[styles.zoomPill, { backgroundColor: theme.hudBg, borderColor: theme.border }]}>
              <Text style={[styles.zoomText, { color: theme.muted }]}>{zoomPct}%</Text>
              <Pressable onPress={fitScreen} style={[styles.fitBtn, { borderLeftColor: theme.border }]}>
                <Text style={[styles.fitText, { color: theme.text }]}>{t("viewer.fit")}</Text>
              </Pressable>
            </View>

            <SlideBar slides={slides} activeIndex={slideIdx} theme={theme} lang={lang} onSelectSlide={selectSlide} />
          </View>
        </SafeAreaView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  webview: {
    flex: 1,
    backgroundColor: "transparent",
  },
  overlayCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  statusText: {
    fontSize: 14,
  },
  errText: {
    fontSize: 14,
    textAlign: "center",
  },
  errBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  topHudWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    height: 48,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    gap: 4,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  backGlyph: {
    fontSize: 28,
    lineHeight: 30,
    marginTop: -2,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 15,
    fontWeight: "600",
  },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  subtitle: {
    fontSize: 11.5,
  },
  shareBtn: {
    paddingHorizontal: 10,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomHudWrap: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  zoomPill: {
    flexDirection: "row",
    alignItems: "center",
    height: 38,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    gap: 10,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  zoomText: {
    fontSize: 12.5,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  fitBtn: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    paddingLeft: 10,
  },
  fitText: {
    fontSize: 12.5,
    fontWeight: "600",
  },
});
