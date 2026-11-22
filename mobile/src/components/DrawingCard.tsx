// 网格里的一张图：真实渲染的缩略图 + 名字 + 时间。点开用 iOS 18 的缩放转场进预览，长按有原生预览和菜单。
import { Image } from 'expo-image';
import { Link } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Native, type DrawingFile } from '@native';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useCanvasDark } from '@/lib/store';
import { colors, radius } from '@/lib/theme';
import { useRendered } from '@/lib/useRendered';

type Props = { file: DrawingFile; width: number; subtitle?: string };

export const DrawingCard = memo(function DrawingCard({ file, width, subtitle }: Props) {
  const dark = useCanvasDark();
  const { rendered, failed } = useRendered(file, dark);
  const height = Math.round(width * 0.72);
  const canvas = colors.canvas(dark);

  return (
    <Link href={{ pathname: '/viewer', params: { id: file.id } }} asChild>
      <Link.Trigger withAppleZoom>
        <Pressable style={{ width }} accessibilityLabel={file.name}>
          <View style={[styles.thumb, { height, backgroundColor: canvas }]}>
            {rendered?.thumbnail ? (
              <Image
                source={{ uri: rendered.thumbnail }}
                style={styles.image}
                contentFit="contain"
                transition={160}
                recyclingKey={file.id}
              />
            ) : !file.downloaded ? (
              <SymbolView name="icloud.and.arrow.down" tintColor={colors.tertiaryLabel} size={26} />
            ) : failed ? (
              <SymbolView name="exclamationmark.triangle" tintColor={colors.tertiaryLabel} size={22} />
            ) : (
              <ActivityIndicator color={dark ? '#666' : '#bbb'} />
            )}
          </View>
          <Text style={styles.name} numberOfLines={1}>
            {file.name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {subtitle ?? formatDate(file.modified)}
          </Text>
        </Pressable>
      </Link.Trigger>
      <Link.Preview style={{ width: 360, height: Math.round(360 * 0.72) }}>
        <View style={[styles.preview, { backgroundColor: canvas }]}>
          {rendered?.thumbnail ? (
            <Image source={{ uri: rendered.thumbnail }} style={styles.image} contentFit="contain" />
          ) : null}
        </View>
      </Link.Preview>
      <Link.Menu>
        <Link.MenuAction
          title={t.shareOriginal}
          icon="square.and.arrow.up"
          onPress={() => void Native.share(file.locationId, file.path, 'original', null, file.name)}
        />
        {rendered?.pdf ? (
          <Link.MenuAction
            title={t.sharePdf}
            icon="doc.richtext"
            onPress={() => void Native.share(file.locationId, file.path, 'pdf', rendered.pdf ?? null, file.name)}
          />
        ) : null}
      </Link.Menu>
    </Link>
  );
});

const styles = StyleSheet.create({
  thumb: {
    borderRadius: radius.card,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { position: 'absolute', top: 6, left: 6, right: 6, bottom: 6 },
  preview: { flex: 1, padding: 8 },
  name: { marginTop: 8, fontSize: 14, fontWeight: '600', color: colors.label },
  meta: { marginTop: 1, fontSize: 12, color: colors.secondaryLabel, fontVariant: ['tabular-nums'] },
});
