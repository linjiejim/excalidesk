// 一个文件夹里面：子文件夹列表 + 图的网格。
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { Native, type DrawingFile, type Folder } from '@native';
import { DrawingGrid } from '@/components/DrawingGrid';
import { EmptyState } from '@/components/EmptyState';
import { Row, Section } from '@/components/GroupedList';
import { t } from '@/lib/i18n';
import { setSort, sortFiles, useStore } from '@/lib/store';
import { colors } from '@/lib/theme';

export default function Browse() {
  const { location, path = '', title } = useLocalSearchParams<{ location: string; path?: string; title?: string }>();
  const sort = useStore((s) => s.sort);
  // the store rescans on foreground / pull to refresh; follow it
  const scanned = useStore((s) => s.files[location]);
  const [data, setData] = useState<{ key: string; folders: Folder[]; files: DrawingFile[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const key = `${location}|${path}`;

  const load = useCallback(
    () =>
      Native.listFolder(location, path)
        .then((d) => setData({ key, ...d }))
        .catch(() => setData({ key, folders: [], files: [] })),
    [location, path, key],
  );

  useEffect(() => {
    void load();
  }, [load, scanned]);

  const files = useMemo(() => sortFiles(data?.files ?? [], sort), [data, sort]);
  const loaded = data?.key === key;
  const folders = useMemo(
    () =>
      [...(data?.folders ?? [])]
        .filter((f) => f.count > 0)
        .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b.modified - a.modified)),
    [data, sort],
  );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Stack.Screen options={{ title: title ?? t.folder }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="arrow.up.arrow.down" title={t.sortBy}>
          <Stack.Toolbar.MenuAction icon="clock" isOn={sort === 'modified'} onPress={() => setSort('modified')}>
            {t.byModified}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="textformat" isOn={sort === 'name'} onPress={() => setSort('name')}>
            {t.byName}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      {!loaded ? (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      ) : folders.length === 0 && files.length === 0 ? (
        <EmptyState icon="doc.questionmark" title={t.emptyFolder} />
      ) : (
        <>
          {folders.length > 0 ? (
            <Section>
              {folders.map((f) => (
                <Row
                  key={f.path}
                  icon="folder"
                  title={f.name}
                  detail={String(f.count)}
                  href={{ pathname: '/folders/browse', params: { location, path: f.path, title: f.name } }}
                />
              ))}
            </Section>
          ) : null}
          <DrawingGrid files={files} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.groupedBackground },
  content: { paddingTop: 8, paddingBottom: 40 },
  loading: { paddingTop: 120, alignItems: 'center' },
});
