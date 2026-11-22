import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { accent, colors, onAccent } from '@/lib/theme';

type Props = { icon: SFSymbol; title: string; body?: string; action?: { label: string; onPress: () => void } };

export function EmptyState({ icon, title, body, action }: Props) {
  return (
    <View style={styles.wrap}>
      <SymbolView name={icon} tintColor={colors.tertiaryLabel} size={52} weight="light" />
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {action ? (
        <Pressable
          onPress={action.onPress}
          style={({ pressed }) => [styles.button, { opacity: pressed ? 0.7 : 1 }]}
          accessibilityRole="button"
        >
          <SymbolView name="folder.badge.plus" tintColor={onAccent as string} size={17} />
          <Text style={styles.buttonText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingHorizontal: 40, paddingTop: 90, gap: 10 },
  title: { marginTop: 8, fontSize: 20, fontWeight: '600', color: colors.label, textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 21, color: colors.secondaryLabel, textAlign: 'center' },
  button: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: accent,
    paddingHorizontal: 20,
    height: 48,
    borderRadius: 24,
  },
  buttonText: { color: onAccent, fontSize: 17, fontWeight: '600' },
});
