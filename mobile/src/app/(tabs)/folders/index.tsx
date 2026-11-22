// 文件夹：用户授权过的文件夹（iCloud 云盘或本机），以及从「文件」App 单独打开过的图。
import { Link, Stack } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { Row, Section } from '@/components/GroupedList';
import { t } from '@/lib/i18n';
import { addFolder, refresh, removeLocation, useStore } from '@/lib/store';
import { colors } from '@/lib/theme';

export default function Folders() {
  const locations = useStore((s) => s.locations);
  const files = useStore((s) => s.files);
  const scanning = useStore((s) => s.scanning);
  const dirs = locations.filter((l) => !l.isFile);
  const singles = locations.filter((l) => l.isFile);

  const removeAction = (id: string) => (
    <Link.MenuAction title={t.remove} subtitle={t.removeHint} icon="minus.circle" destructive onPress={() => removeLocation(id)} />
  );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={scanning && locations.length > 0} onRefresh={() => void refresh()} />}
    >
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="folder.badge.plus" accessibilityLabel={t.addFolder} onPress={() => void addFolder()} />
      </Stack.Toolbar>

      {locations.length === 0 ? (
        <EmptyState
          icon="folder"
          title={t.emptyTitle}
          body={t.emptyBody}
          action={{ label: t.addFolder, onPress: () => void addFolder() }}
        />
      ) : (
        <>
          {dirs.length > 0 ? (
            <Section>
              {dirs.map((loc) => (
                <Row
                  key={loc.id}
                  icon={loc.isCloud ? 'icloud' : 'folder'}
                  title={loc.name}
                  dimmed={!loc.available}
                  detail={loc.available ? String(files[loc.id]?.length ?? '') : t.unavailable}
                  href={{ pathname: '/folders/browse', params: { location: loc.id, path: '', title: loc.name } }}
                  menu={removeAction(loc.id)}
                />
              ))}
            </Section>
          ) : null}
          {singles.length > 0 ? (
            <Section header={t.allFiles}>
              {singles.map((loc) => (
                <Row
                  key={loc.id}
                  icon="doc"
                  iconColor={colors.secondaryLabel as unknown as string}
                  title={loc.name}
                  dimmed={!loc.available}
                  href={{ pathname: '/viewer', params: { id: `${loc.id}:` } }}
                  menu={removeAction(loc.id)}
                />
              ))}
            </Section>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.groupedBackground },
  content: { paddingTop: 8, paddingBottom: 40 },
});
