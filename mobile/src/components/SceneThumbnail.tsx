import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Ellipse, Polygon, Polyline, Rect } from "react-native-svg";
import { extractThumbnailPrimitives, parseExcalidrawJson } from "../lib/excalidraw";
import type { ThemeColors } from "../theme";

interface Props {
  rawJson?: string;
  theme: ThemeColors;
  width?: number;
  height?: number;
}

export const SceneThumbnail = React.memo(function SceneThumbnail({ rawJson, theme, width = 84, height = 56 }: Props) {
  const primitives = useMemo(() => {
    if (!rawJson) return [];
    try {
      return extractThumbnailPrimitives(parseExcalidrawJson(rawJson), 90);
    } catch {
      return [];
    }
  }, [rawJson]);

  return (
    <View
      style={[
        styles.box,
        {
          width,
          height,
          backgroundColor: theme.dark ? "#161618" : "#fafafa",
          borderColor: theme.border,
        },
      ]}
    >
      <Svg width={width} height={height} viewBox="0 0 100 64">
        {primitives.length === 0 ? (
          <Rect x={24} y={20} width={52} height={24} rx={4} stroke={theme.muted} strokeWidth={1.2} strokeDasharray="3 3" fill="none" opacity={0.45} />
        ) : (
          primitives.map((p, idx) => {
            const stroke = theme.dark && p.kind !== "frame" && (p.stroke === "#1e1e1e" || p.stroke === "#000000") ? "#e5e5ea" : "stroke" in p ? p.stroke : "#868e96";
            switch (p.kind) {
              case "frame":
                return <Rect key={idx} x={p.x} y={p.y} width={p.w} height={p.h} rx={2} stroke="#adb5bd" strokeWidth={0.9} fill="none" opacity={0.6} />;
              case "rect":
                return <Rect key={idx} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.rx} stroke={stroke} strokeWidth={1.2} fill={p.fill} />;
              case "ellipse":
                return <Ellipse key={idx} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} stroke={stroke} strokeWidth={1.2} fill={p.fill} />;
              case "polygon":
                return <Polygon key={idx} points={p.points} stroke={stroke} strokeWidth={1.2} fill={p.fill} />;
              case "polyline":
                return <Polyline key={idx} points={p.points} stroke={stroke} strokeWidth={1.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
            }
          })
        )}
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  box: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
});
