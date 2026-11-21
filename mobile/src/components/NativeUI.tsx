import type { ReactNode } from "react";
import { ActionSheetIOS, Alert, Platform, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import SegmentedControl from "@react-native-segmented-control/segmented-control";
import Svg, { Circle, Ellipse, G, Line, Path, Polyline, Rect } from "react-native-svg";
import type { ThemeColors } from "../theme";

export type AppIconName =
  | "folder"
  | "folder.fill"
  | "link"
  | "gearshape"
  | "gearshape.fill"
  | "plus"
  | "arrow.up.arrow.down"
  | "magnifyingglass"
  | "star"
  | "star.fill"
  | "icloud"
  | "icloud.and.arrow.down"
  | "chevron.left"
  | "chevron.right"
  | "square.and.arrow.up"
  | "moon"
  | "sun.max"
  | "doc.text"
  | "xmark";

function VectorFallback({ name, size, color }: { name: AppIconName; size: number; color: string }) {
  const sw = 1.65;
  switch (name) {
    case "folder":
    case "folder.fill":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6c.6 0 1.2.27 1.6.73l1.1 1.27h6.7A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z"
            fill={name === "folder.fill" ? color : "none"}
            stroke={color}
            strokeWidth={sw}
            strokeLinejoin="round"
          />
        </Svg>
      );
    case "link":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.2 4.7" stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <Path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.6-1.6" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </Svg>
      );
    case "gearshape":
    case "gearshape.fill":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={sw} />
          <Path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
            stroke={color}
            strokeWidth={sw}
            strokeLinejoin="round"
          />
        </Svg>
      );
    case "plus":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Line x1={12} y1={5} x2={12} y2={19} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
          <Line x1={5} y1={12} x2={19} y2={12} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
        </Svg>
      );
    case "arrow.up.arrow.down":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path d="M7 18V6M7 6l-3 3M7 6l3 3M17 6v12M17 18l-3-3M17 18l3-3" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      );
    case "magnifyingglass":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Circle cx={11} cy={11} r={6.5} stroke={color} strokeWidth={sw} />
          <Line x1={16} y1={16} x2={20.5} y2={20.5} stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </Svg>
      );
    case "star":
    case "star.fill":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.8L12 16.77 6.8 19.52l.99-5.8-4.21-4.1 5.82-.85L12 3.5Z"
            fill={name === "star.fill" ? color : "none"}
            stroke={color}
            strokeWidth={sw}
            strokeLinejoin="round"
          />
        </Svg>
      );
    case "icloud":
    case "icloud.and.arrow.down":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M6.5 18h11a4 4 0 0 0 .8-7.92A5.5 5.5 0 0 0 7.6 8.5 4.2 4.2 0 0 0 6.5 18Z"
            stroke={color}
            strokeWidth={sw}
            strokeLinejoin="round"
          />
          {name === "icloud.and.arrow.down" && (
            <Path d="M12 11v5m0 0-2-2m2 2 2-2" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
          )}
        </Svg>
      );
    case "chevron.left":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Polyline points="15 5 8 12 15 19" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      );
    case "chevron.right":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Polyline points="9 5 16 12 9 19" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      );
    case "square.and.arrow.up":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path d="M12 3v12M12 3l-4 4M12 3l4 4" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
          <Path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </Svg>
      );
    case "moon":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
        </Svg>
      );
    case "sun.max":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Circle cx={12} cy={12} r={4} stroke={color} strokeWidth={sw} />
          <Path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </Svg>
      );
    case "doc.text":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path d="M6 3h8l4 4v14H6V3Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
          <Line x1={9} y1={11} x2={15} y2={11} stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <Line x1={9} y1={15} x2={15} y2={15} stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </Svg>
      );
    case "xmark":
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Line x1={6} y1={6} x2={18} y2={18} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
          <Line x1={18} y1={6} x2={6} y2={18} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
        </Svg>
      );
  }
}

/** Genuine Apple SF Symbol on iOS, crisp monochrome vector fallback on Web / Android. */
export function NativeIcon({
  name,
  size = 18,
  color,
  weight = "regular",
}: {
  name: AppIconName;
  size?: number;
  color: string;
  weight?: "regular" | "medium" | "semibold";
}) {
  if (Platform.OS === "ios") {
    return (
      <SymbolView
        name={name}
        size={size}
        tintColor={color}
        weight={weight}
        resizeMode="scaleAspectFit"
        fallback={<VectorFallback name={name} size={size} color={color} />}
      />
    );
  }
  return <VectorFallback name={name} size={size} color={color} />;
}

/** Native UIKit UISegmentedControl on iOS, native-styled segmented control on Web / Android. */
export function NativeSegmented<T extends string>({
  value,
  options,
  theme,
  onChange,
  style,
}: {
  value: T;
  options: [T, string][];
  theme: ThemeColors;
  onChange: (v: T) => void;
  style?: ViewStyle;
}) {
  const selectedIndex = Math.max(
    0,
    options.findIndex(([k]) => k === value),
  );
  return (
    <SegmentedControl
      values={options.map(([, label]) => label)}
      selectedIndex={selectedIndex}
      appearance={theme.dark ? "dark" : "light"}
      style={[styles.segmented, style]}
      onChange={(e) => {
        const idx = e.nativeEvent.selectedSegmentIndex;
        const next = options[idx]?.[0];
        if (next && next !== value) {
          hapticSelection();
          onChange(next);
        }
      }}
    />
  );
}

/** Native UIVisualEffectView blur on iOS, translucent surface on Web / Android. */
export function NativeBlur({
  dark,
  style,
  children,
}: {
  dark: boolean;
  style?: ViewStyle | ViewStyle[];
  children?: ReactNode;
}) {
  if (Platform.OS === "ios") {
    return (
      <BlurView
        intensity={80}
        tint={dark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
        style={style}
      >
        {children}
      </BlurView>
    );
  }
  return (
    <View
      style={[
        { backgroundColor: dark ? "rgba(28, 28, 30, 0.9)" : "rgba(255, 255, 255, 0.9)" },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Authentic iOS insetGrouped section container with optional header and footer. */
export function GroupedSection({
  header,
  footer,
  theme,
  children,
}: {
  header?: string;
  footer?: string;
  theme: ThemeColors;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      {!!header && <Text style={[styles.sectionHeader, { color: theme.muted }]}>{header}</Text>}
      <View style={[styles.sectionCard, { backgroundColor: theme.surface }]}>{children}</View>
      {!!footer && <Text style={[styles.sectionFooter, { color: theme.muted }]}>{footer}</Text>}
    </View>
  );
}

export function BrandMark({ theme, size = 20 }: { theme: ThemeColors; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={1.5} y={1.5} width={21} height={21} rx={6} fill={theme.logoTile} stroke={theme.border} strokeWidth={0.8} />
      <G fill={theme.logoFill} stroke={theme.text} strokeWidth={1.1} strokeLinejoin="round">
        <Rect x={6.35} y={5} width={3.1} height={13.7} />
        <Rect x={9.45} y={5} width={8} height={3.2} />
        <Path d="M9.25 11.7 L13.05 10.05 L16.95 11.7 L13.05 13.35 Z" />
        <Ellipse cx={13.55} cy={16.95} rx={4.1} ry={1.8} />
      </G>
    </Svg>
  );
}

export function hapticSelection() {
  if (Platform.OS === "ios") {
    void Haptics.selectionAsync().catch(() => {});
  }
}

export function hapticLight() {
  if (Platform.OS === "ios") {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }
}

export interface ActionSheetItem {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

/** Native UIKit UIAlertController (.actionSheet) on iOS, Alert fallback elsewhere. */
export function showNativeActionSheet({
  title,
  cancelLabel,
  items,
}: {
  title?: string;
  cancelLabel: string;
  items: ActionSheetItem[];
}) {
  if (Platform.OS === "ios") {
    const destructiveButtonIndex = items.findIndex((i) => i.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...items.map((i) => i.label), cancelLabel],
        cancelButtonIndex: items.length,
        destructiveButtonIndex: destructiveButtonIndex >= 0 ? destructiveButtonIndex : undefined,
      },
      (idx) => {
        if (idx >= 0 && idx < items.length) {
          items[idx].onPress();
        }
      },
    );
    return;
  }
  Alert.alert(
    title || "",
    undefined,
    [
      ...items.map((i) => ({
        text: i.label,
        style: i.destructive ? ("destructive" as const) : ("default" as const),
        onPress: i.onPress,
      })),
      { text: cancelLabel, style: "cancel" as const },
    ],
  );
}

const styles = StyleSheet.create({
  segmented: {
    height: 32,
  },
  section: {
    marginBottom: 20,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "500",
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  sectionCard: {
    borderRadius: 10,
    overflow: "hidden",
  },
  sectionFooter: {
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 16,
    marginTop: 6,
  },
});
