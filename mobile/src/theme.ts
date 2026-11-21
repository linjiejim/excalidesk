export interface ThemeColors {
  dark: boolean;
  bg: string;
  bar: string;
  surface: string;
  card: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  logoTile: string;
  logoFill: string;
  live: string;
  warn: string;
  danger: string;
  hudBg: string;
}

export const LIGHT_THEME: ThemeColors = {
  dark: false,
  bg: "#f4f4f2",
  bar: "#f4f4f2",
  surface: "#ffffff",
  card: "#ffffff",
  border: "rgba(0, 0, 0, 0.08)",
  text: "#1d1d1f",
  muted: "#86868b",
  accent: "#1d1d1f",
  accentText: "#ffffff",
  accentSoft: "rgba(0, 0, 0, 0.06)",
  logoTile: "#ffffff",
  logoFill: "#cdcbf5",
  live: "#2f9e44",
  warn: "#d97706",
  danger: "#d1453b",
  hudBg: "rgba(255, 255, 255, 0.94)",
};

export const DARK_THEME: ThemeColors = {
  dark: true,
  bg: "#121212",
  bar: "#1e1e20",
  surface: "#1c1c1e",
  card: "#1e1e20",
  border: "rgba(255, 255, 255, 0.09)",
  text: "#ececec",
  muted: "#8e8e93",
  accent: "#ececec",
  accentText: "#121212",
  accentSoft: "rgba(255, 255, 255, 0.1)",
  logoTile: "#2c2c30",
  logoFill: "#55529a",
  live: "#69db7c",
  warn: "#fbbf24",
  danger: "#ff6b6b",
  hudBg: "rgba(28, 28, 30, 0.94)",
};
