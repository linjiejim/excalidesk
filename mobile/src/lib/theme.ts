import { DynamicColorIOS, PlatformColor, type ColorValue } from 'react-native';

/** Excalidraw violet, the app's only accent */
export const accent: ColorValue = DynamicColorIOS({ light: '#6965db', dark: '#a8a5ff' });
/** Text and icons on an accent-filled button */
export const onAccent: ColorValue = DynamicColorIOS({ light: '#ffffff', dark: '#1b1a33' });

export const colors = {
  label: PlatformColor('label'),
  secondaryLabel: PlatformColor('secondaryLabel'),
  tertiaryLabel: PlatformColor('tertiaryLabel'),
  separator: PlatformColor('separator'),
  background: PlatformColor('systemBackground'),
  groupedBackground: PlatformColor('systemGroupedBackground'),
  cell: PlatformColor('secondarySystemGroupedBackground'),
  fill: PlatformColor('tertiarySystemFill'),
  /** Card behind a thumbnail: the canvas color, so the drawing's own background blends in */
  canvas: (dark: boolean) => (dark ? '#121212' : '#ffffff'),
};

export const radius = { card: 12, cell: 26 };
