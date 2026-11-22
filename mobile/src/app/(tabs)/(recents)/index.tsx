// 最近：所有文件夹里的图，按「最近打开或修改」排，最多 40 张。
import { router } from 'expo-router';
import { useMemo } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { DrawingGrid } from '@/components/DrawingGrid';
import { EmptyState } from '@/components/EmptyState';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';
import { addFolder, refresh, useStore } from '@/lib/store';

export default function Recents() {
  const files = useStore((s) => s.files);
  const recents = useStore((s) => s.recents);
  const locations = useStore((s) => s.locations);
  const scanning = useStore((s) => s.scanning);

  const list = useMemo(() => {
    const opened = new Map(recents.map((r) => [r.id, r.at]));
    return Object.values(files)
      .flat()
      .map((f) => ({ f, at: Math.max(opened.get(f.id) ?? 0, f.modified) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 40);
  }, [files, recents]);
  const activity = useMemo(() => new Map(list.map((x) => [x.f.id, x.at])), [list]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={styles.root}
      refreshControl={<RefreshControl refreshing={scanning && list.length > 0} onRefresh={() => void refresh()} />}
    >
      {locations.length === 0 ? (
        <EmptyState
          icon="square.on.square.dashed"
          title={t.emptyTitle}
          body={t.emptyBody}
          action={{
            label: t.addFolder,
            onPress: () =>
              void addFolder().then((loc) => {
                if (loc) router.navigate('/folders');
              }),
          }}
        />
      ) : list.length === 0 && !scanning ? (
        <EmptyState icon="clock" title={t.noRecents} />
      ) : (
        <View style={styles.content}>
          <DrawingGrid files={list.map((x) => x.f)} subtitle={(f) => formatDate(activity.get(f.id) ?? f.modified)} />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingTop: 8, paddingBottom: 40 },
});
