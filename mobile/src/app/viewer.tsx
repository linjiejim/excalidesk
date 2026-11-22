// 预览：PDFKit 原生画布（双指缩放、惯性滚动、双击放大、两指单击缩小），单击隐藏/显示工具栏。
// 有 frame 的图可以切到「按页查看」：一页一个 frame，左右滑翻页，底部工具栏翻页和看备注。
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { GlassView } from 'expo-glass-effect';

import { DrawingView, Native, type DrawingFile, type DrawingViewHandle, type Rendered } from '@native';
import { t } from '@/lib/i18n';
import { findFile, markOpened, setCanvas, setNotes, useCanvasDark, useStore } from '@/lib/store';
import { accent, colors } from '@/lib/theme';

/** The store may not have scanned yet (cold start from the Files app): fall back to what the id says. */
function fallbackFile(id: string): DrawingFile {
  const sep = id.indexOf(':');
  const locationId = id.slice(0, sep);
  const path = id.slice(sep + 1);
  const base = path.split('/').pop() ?? '';
  return {
    id,
    locationId,
    path,
    name: base.replace(/\.excalidraw$/i, ''),
    size: 0,
    modified: 0,
    isCloud: false,
    downloaded: true,
  };
}

function errorText(message: string) {
  if (message.includes('not_excalidraw') || message.includes('JSON')) return t.notExcalidraw;
  if (message.includes('location_not_found') || message.includes('NSCocoaErrorDomain Code=260')) return t.missing;
  return message;
}

export default function Viewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const stored = useStore((s) => findFile(id, s));
  const locName = useStore((s) => s.locations.find((l) => id.startsWith(`${l.id}:`))?.name ?? '');
  const file = stored ?? fallbackFile(id);
  const name = file.name || locName;
  const dark = useCanvasDark();
  const canvasPref = useStore((s) => s.canvas);

  const [paged, setPaged] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [page, setPage] = useState({ index: 0, count: 0 });
  const [zoom, setZoom] = useState<{ value: number; at: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [doc, setDoc] = useState<{ key: string; value: Rendered | null; error: string | null }>({
    key: '',
    value: null,
    error: null,
  });
  const viewRef = useRef<DrawingViewHandle>(null);

  useEffect(() => {
    markOpened(id);
  }, [id]);

  // Cached render of this version first (instant), otherwise render now at high priority
  const key = `${id}|${file.modified}|${dark}|${paged}|${attempt}`;
  const cached = file.modified ? Native.cached(file.locationId, file.path, file.modified, file.size, dark) : null;
  useEffect(() => {
    let alive = true;
    Native.render(file.locationId, file.path, { dark, want: paged ? 'slides' : 'canvas', priority: 'high' })
      .then((value) => alive && setDoc({ key, value, error: null }))
      .catch((e: Error) => alive && setDoc({ key, value: null, error: errorText(String(e?.message ?? e)) }));
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = doc.key === key ? doc.value : null;
  const meta = current ?? (doc.value && doc.key.startsWith(`${id}|`) ? doc.value : null) ?? cached;
  const source = paged ? current?.slidesPdf : (current?.pdf ?? (!paged ? cached?.pdf : undefined));
  const slides = meta?.slides ?? [];
  const background = (dark ? meta?.darkBackground : meta?.background) ?? colors.canvas(dark);
  const error = doc.key === key ? doc.error : null;

  // zoom badge fades out shortly after the last change
  useEffect(() => {
    if (!zoom) return;
    const timer = setTimeout(() => setZoom(null), 900);
    return () => clearTimeout(timer);
  }, [zoom]);

  const share = (kind: 'original' | 'pdf') =>
    void Native.share(file.locationId, file.path, kind, kind === 'pdf' ? (source ?? null) : null, name);

  const openNotes = () => {
    const slide = slides[page.index];
    if (!slide) return;
    setNotes({ slide, index: page.index, count: slides.length });
    router.push('/notes');
  };

  const goto = (index: number) => {
    void viewRef.current?.goToPage(Math.max(0, Math.min(page.count - 1, index)));
  };

  return (
    <>
      <View style={[styles.root, { backgroundColor: background }]}>
        <Stack.Screen
          options={{
            title: name,
            headerShown: chrome,
            statusBarHidden: !chrome,
            statusBarAnimation: 'fade',
            // bars follow the canvas, not the system, so they stay readable over a dark canvas in light mode
            statusBarStyle: dark ? 'light' : 'dark',
            headerUserInterfaceStyle: dark ? 'dark' : 'light',
            headerTransparent: true,
            headerTitleStyle: { color: dark ? '#f5f5f5' : '#1e1e1e' },
            headerTintColor: dark ? '#f5f5f5' : '#1e1e1e',
          }}
        />

        {chrome ? (
          <Stack.Toolbar placement="right">
            {slides.length > 0 ? (
              <Stack.Toolbar.Button
                icon={paged ? 'rectangle.split.3x1.fill' : 'rectangle.split.3x1'}
                accessibilityLabel={paged ? t.canvas : t.slides}
                selected={paged}
                onPress={() => setPaged((p) => !p)}
              />
            ) : null}
            <Stack.Toolbar.Menu icon="square.and.arrow.up" title={t.share}>
              <Stack.Toolbar.MenuAction icon="doc" onPress={() => share('original')}>
                {t.shareOriginal}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="doc.richtext" disabled={!source} onPress={() => share('pdf')}>
                {t.sharePdf}
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.Menu icon="ellipsis" title={t.more}>
              <Stack.Toolbar.Menu inline title={t.canvasTheme}>
                <Stack.Toolbar.MenuAction icon="circle.lefthalf.filled" isOn={canvasPref === 'system'} onPress={() => setCanvas('system')}>
                  {t.followSystem}
                </Stack.Toolbar.MenuAction>
                <Stack.Toolbar.MenuAction icon="sun.max" isOn={canvasPref === 'light'} onPress={() => setCanvas('light')}>
                  {t.light}
                </Stack.Toolbar.MenuAction>
                <Stack.Toolbar.MenuAction icon="moon" isOn={canvasPref === 'dark'} onPress={() => setCanvas('dark')}>
                  {t.dark}
                </Stack.Toolbar.MenuAction>
              </Stack.Toolbar.Menu>
              <Stack.Toolbar.MenuAction icon="arrow.up.left.and.arrow.down.right" onPress={() => void viewRef.current?.fit()}>
                {t.fit}
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          </Stack.Toolbar>
        ) : null}

        {paged && chrome && page.count > 0 ? (
          <Stack.Toolbar>
            <Stack.Toolbar.Button icon="chevron.left" disabled={page.index <= 0} onPress={() => goto(page.index - 1)} />
            <Stack.Toolbar.Spacer />
            <Stack.Toolbar.View hidesSharedBackground>
              <View style={styles.pageLabelBox} collapsable={false}>
                <Text style={[styles.pageLabel, { color: dark ? '#f5f5f5' : '#1e1e1e' }]} numberOfLines={1}>
                  {page.index + 1} / {page.count}
                </Text>
                {slides[page.index]?.name ? (
                  <Text style={styles.pageName} numberOfLines={1}>
                    {slides[page.index].name}
                  </Text>
                ) : null}
              </View>
            </Stack.Toolbar.View>
            <Stack.Toolbar.Spacer />
            <Stack.Toolbar.Button
              icon="text.bubble"
              accessibilityLabel={t.notes}
              disabled={!slides[page.index]?.notes}
              onPress={openNotes}
            />
            <Stack.Toolbar.Button icon="chevron.right" disabled={page.index >= page.count - 1} onPress={() => goto(page.index + 1)} />
          </Stack.Toolbar>
        ) : null}

        {source ? (
          <DrawingView
            key={source}
            ref={viewRef}
            style={StyleSheet.absoluteFill}
            source={source}
            paged={paged}
            canvasColor={background}
            onSingleTap={() => setChrome((c) => !c)}
            onZoomChange={(e) => setZoom({ value: e.nativeEvent.scale, at: Date.now() })}
            onPageChange={(e) => setPage(e.nativeEvent)}
            onReady={(e) => setPage({ index: 0, count: e.nativeEvent.pageCount })}
          />
        ) : error ? (
          <View style={styles.center}>
            <SymbolView name="exclamationmark.triangle" tintColor={colors.secondaryLabel} size={40} weight="light" />
            <Text style={[styles.errorTitle, { color: dark ? '#f5f5f5' : '#1e1e1e' }]}>{t.openFailed}</Text>
            <Text style={styles.errorBody}>{error}</Text>
            <Pressable onPress={() => setAttempt((a) => a + 1)} style={({ pressed }) => [styles.retry, { opacity: pressed ? 0.6 : 1 }]}>
              <Text style={styles.retryText}>{t.retry}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.center} pointerEvents="none">
            {cached?.thumbnail && !paged ? (
              <Image source={{ uri: cached.thumbnail }} style={styles.placeholder} contentFit="contain" />
            ) : null}
            <View style={styles.loadingRow}>
              <ActivityIndicator color={dark ? '#aaa' : '#888'} />
              <Text style={styles.loadingText}>{file.downloaded ? t.rendering : t.downloading}</Text>
            </View>
          </View>
        )}

        {zoom ? (
          <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(260)} style={styles.zoomWrap} pointerEvents="none">
            <GlassView style={styles.zoomBadge} glassEffectStyle="regular">
              <Text style={[styles.zoomText, { color: dark ? '#f5f5f5' : '#1e1e1e' }]}>{Math.round(zoom.value * 100)}%</Text>
            </GlassView>
          </Animated.View>
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  placeholder: { position: 'absolute', top: 120, bottom: 120, left: 16, right: 16, opacity: 0.55 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  loadingText: { color: colors.secondaryLabel, fontSize: 15 },
  errorTitle: { fontSize: 18, fontWeight: '600', marginTop: 6 },
  errorBody: { fontSize: 14, color: colors.secondaryLabel, textAlign: 'center' },
  retry: { marginTop: 8, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 18, backgroundColor: colors.fill },
  retryText: { color: accent, fontSize: 16, fontWeight: '600' },
  zoomWrap: { position: 'absolute', top: 120, alignSelf: 'center' },
  zoomBadge: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18, overflow: 'hidden' },
  zoomText: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pageLabelBox: { width: 160, height: 44, alignItems: 'center', justifyContent: 'center' },
  pageLabel: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pageName: { fontSize: 11, color: colors.secondaryLabel, maxWidth: 150 },
});
