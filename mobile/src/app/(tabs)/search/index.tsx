// 搜索：文件名 + 图里的文字。第一次进来时在后台给还没索引过的图建摘要（只解析，不渲染）。
import { Image } from 'expo-image';
import { Link, Stack } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Native, type DrawingFile } from '@native';
import { EmptyState } from '@/components/EmptyState';
import { formatDate, snippet } from '@/lib/format';
import { t } from '@/lib/i18n';
import { locationName, useCanvasDark, useStore } from '@/lib/store';
import { colors } from '@/lib/theme';
import { useRendered } from '@/lib/useRendered';

export default function Search() {
  const files = useStore((s) => s.files);
  const all = useMemo(() => Object.values(files).flat(), [files]);
  const [query, setQuery] = useState('');
  // what's already indexed (cached summaries) is read right away; the rest is parsed in the background
  const base = useMemo(() => {
    const index: Record<string, string> = {};
    const todo: DrawingFile[] = [];
    for (const f of all) {
      const hit = Native.cached(f.locationId, f.path, f.modified, f.size, false);
      if (hit) index[f.id] = hit.text ?? '';
      else if (f.downloaded) todo.push(f);
    }
    return { index, todo };
  }, [all]);
  const [extra, setExtra] = useState<{ of: typeof base | null; texts: Record<string, string>; done: number }>({
    of: null,
    texts: {},
    done: 0,
  });

  useEffect(() => {
    let alive = true;
    const texts: Record<string, string> = {};
    void (async () => {
      for (let i = 0; i < base.todo.length && alive; i++) {
        const f = base.todo[i];
        try {
          const r = await Native.render(f.locationId, f.path, { dark: false, want: 'meta', priority: 'low' });
          texts[f.id] = r.text ?? '';
        } catch {
          texts[f.id] = '';
        }
        if (alive) setExtra({ of: base, texts: { ...texts }, done: i + 1 });
      }
    })();
    return () => {
      alive = false;
    };
  }, [base]);

  const texts = useMemo(
    () => (extra.of === base ? { ...base.index, ...extra.texts } : base.index),
    [base, extra],
  );
  const progress = { done: extra.of === base ? extra.done : 0, total: base.todo.length };

  const q = query.trim();
  const results = useMemo(() => {
    if (!q) return [];
    const lower = q.toLowerCase();
    return all
      .map((f) => {
        const inName = f.name.toLowerCase().includes(lower);
        const snip = snippet(texts[f.id] ?? '', q);
        return inName || snip ? { f, snip: snip ?? undefined, rank: inName ? 0 : 1 } : null;
      })
      .filter((x): x is { f: DrawingFile; snip: string | undefined; rank: number } => !!x)
      .sort((a, b) => a.rank - b.rank || b.f.modified - a.f.modified)
      .slice(0, 100);
  }, [all, texts, q]);

  const indexing = progress.total > 0 && progress.done < progress.total;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.root} keyboardDismissMode="on-drag">
      <Stack.SearchBar
        placeholder={t.searchPlaceholder}
        onChangeText={(e) => setQuery(e.nativeEvent.text)}
        onCancelButtonPress={() => setQuery('')}
      />
      {!q ? (
        <EmptyState icon="text.magnifyingglass" title={t.search} body={t.searchHint} />
      ) : results.length === 0 ? (
        <EmptyState icon="magnifyingglass" title={t.noResults} />
      ) : (
        <View style={styles.list}>
          {results.map(({ f, snip }) => (
            <Result key={f.id} file={f} snippet={snip} />
          ))}
        </View>
      )}
      {indexing ? <Text style={styles.indexing}>{t.indexing(progress.done, progress.total)}</Text> : null}
    </ScrollView>
  );
}

function Result({ file, snippet: snip }: { file: DrawingFile; snippet?: string }) {
  const dark = useCanvasDark();
  const { rendered } = useRendered(file, dark);
  const folder = useStore((s) => locationName(file.locationId, s));
  return (
    <Link href={{ pathname: '/viewer', params: { id: file.id } }} asChild>
      <Link.Trigger withAppleZoom>
        <Pressable>
          {({ pressed }) => (
            <View style={[styles.row, pressed && { backgroundColor: colors.fill }]}>
              <View style={[styles.thumb, { backgroundColor: colors.canvas(dark) }]}>
                {rendered?.thumbnail ? (
                  <Image source={{ uri: rendered.thumbnail }} style={styles.thumbImage} contentFit="contain" />
                ) : (
                  <SymbolView name={file.downloaded ? 'doc' : 'icloud.and.arrow.down'} tintColor={colors.tertiaryLabel} size={18} />
                )}
              </View>
              <View style={styles.texts}>
                <Text style={styles.name} numberOfLines={1}>
                  {file.name}
                </Text>
                {snip ? (
                  <Text style={styles.snippet} numberOfLines={2}>
                    {snip}
                  </Text>
                ) : null}
                <Text style={styles.meta} numberOfLines={1}>
                  {[folder, formatDate(file.modified)].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </View>
          )}
        </Pressable>
      </Link.Trigger>
    </Link>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { paddingTop: 4, paddingBottom: 40 },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center' },
  thumb: {
    width: 76,
    height: 56,
    borderRadius: 9,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImage: { position: 'absolute', top: 3, left: 3, right: 3, bottom: 3 },
  texts: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 16, fontWeight: '600', color: colors.label },
  snippet: { fontSize: 14, lineHeight: 19, color: colors.label, opacity: 0.85 },
  meta: { fontSize: 12, color: colors.secondaryLabel },
  indexing: { textAlign: 'center', color: colors.secondaryLabel, fontSize: 12, paddingVertical: 16 },
});
