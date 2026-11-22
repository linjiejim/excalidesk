// iOS 设置风格的分组列表：圆角卡片、左侧 SF Symbol、右侧箭头，长按有原生菜单。
import { Link, type Href } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Children, Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { accent, colors, radius } from '@/lib/theme';

export function Section({ header, footer, children }: { header?: string; footer?: string; children: ReactNode }) {
  const items = Children.toArray(children);
  return (
    <View style={styles.section}>
      {header ? <Text style={styles.header}>{header}</Text> : null}
      <View style={styles.card}>
        {items.map((child, i) => (
          <Fragment key={i}>
            {child}
            {i < items.length - 1 ? <View style={styles.separator} /> : null}
          </Fragment>
        ))}
      </View>
      {footer ? <Text style={styles.footer}>{footer}</Text> : null}
    </View>
  );
}

type RowProps = {
  icon: SFSymbol;
  iconColor?: string | ReturnType<typeof colors.canvas> | typeof accent;
  title: string;
  detail?: string;
  href: Href;
  dimmed?: boolean;
  menu?: ReactNode;
};

export function Row({ icon, iconColor, title, detail, href, dimmed, menu }: RowProps) {
  return (
    <Link href={href} asChild>
      <Link.Trigger>
        <Pressable>
          {({ pressed }) => (
            <View style={[styles.row, pressed && styles.pressed]}>
              <SymbolView name={icon} tintColor={(iconColor as string) ?? accent} size={22} style={styles.icon} />
              <View style={styles.texts}>
                <Text style={[styles.title, dimmed && styles.dimmed]} numberOfLines={1}>
                  {title}
                </Text>
              </View>
              {detail ? <Text style={styles.detail}>{detail}</Text> : null}
              <SymbolView name="chevron.right" tintColor={colors.tertiaryLabel} size={13} weight="semibold" />
            </View>
          )}
        </Pressable>
      </Link.Trigger>
      {menu ? <Link.Menu>{menu}</Link.Menu> : null}
    </Link>
  );
}

const styles = StyleSheet.create({
  section: { marginHorizontal: 16, marginBottom: 22 },
  header: {
    fontSize: 13,
    color: colors.secondaryLabel,
    textTransform: 'uppercase',
    marginLeft: 16,
    marginBottom: 7,
  },
  footer: { fontSize: 13, color: colors.secondaryLabel, marginHorizontal: 16, marginTop: 7, lineHeight: 18 },
  card: {
    backgroundColor: colors.cell,
    borderRadius: radius.cell,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 56 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 16, gap: 12 },
  pressed: { backgroundColor: colors.fill },
  icon: { width: 28, height: 28 },
  texts: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, color: colors.label },
  dimmed: { color: colors.secondaryLabel },
  detail: { fontSize: 15, color: colors.secondaryLabel, fontVariant: ['tabular-nums'] },
});
