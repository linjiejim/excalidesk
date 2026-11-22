// 自适应列数的图网格（iPhone 竖屏两列，横屏和 iPad 更多列）。
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import type { DrawingFile } from '@native';
import { DrawingCard } from './DrawingCard';

const GAP = 14;
const PAD = 16;
const MIN_CARD = 150;

export function DrawingGrid({ files, subtitle }: { files: DrawingFile[]; subtitle?: (f: DrawingFile) => string | undefined }) {
  const { width } = useWindowDimensions();
  const inner = width - PAD * 2;
  const cols = Math.max(2, Math.floor((inner + GAP) / (MIN_CARD + GAP)));
  const cardW = Math.floor((inner - GAP * (cols - 1)) / cols);

  return (
    <View style={styles.grid}>
      {files.map((f) => (
        // fixed-width cell: the zoom-transition wrapper around the card would otherwise take the whole row
        <View key={f.id} style={{ width: cardW }}>
          <DrawingCard file={f} width={cardW} subtitle={subtitle?.(f)} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: GAP, rowGap: 18, paddingHorizontal: PAD },
});
