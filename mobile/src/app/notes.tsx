// 当前页的演讲者备注（半屏表单，可拉到全屏）。
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { t } from '@/lib/i18n';
import { useStore } from '@/lib/store';
import { colors } from '@/lib/theme';

export default function Notes() {
  const notes = useStore((s) => s.notes);
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.head}>
        <Text style={styles.kicker}>
          {t.notes} · {notes ? `${notes.index + 1} / ${notes.count}` : ''}
        </Text>
        <Text style={styles.title}>{notes?.slide.name}</Text>
      </View>
      <Text style={styles.body} selectable>
        {notes?.slide.notes || t.noNotes}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: 24, paddingTop: 28, gap: 16 },
  head: { gap: 4 },
  kicker: { fontSize: 13, color: colors.secondaryLabel, fontWeight: '600', fontVariant: ['tabular-nums'] },
  title: { fontSize: 22, fontWeight: '700', color: colors.label },
  body: { fontSize: 17, lineHeight: 26, color: colors.label },
});
