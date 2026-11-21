export interface ThemeColors {
  dark: boolean;
  bg: string;
  bar: string;
  surface: string;
  card: string;
  border: string;
  separator: string;
  pressed: string;
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
  separator: "rgba(60, 60, 67, 0.14)",
  pressed: "rgba(0, 0, 0, 0.05)",
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
  hudBg: "rgba(255, 255, 255, 0.82)",
};

export const DARK_THEME: ThemeColors = {
  dark: true,
  bg: "#000000",
  bar: "#1c1c1e",
  surface: "#1c1c1e",
  card: "#1c1c1e",
  border: "rgba(255, 255, 255, 0.1)",
  separator: "rgba(84, 84, 88, 0.45)",
  pressed: "rgba(255, 255, 255, 0.07)",
  text: "#f2f2f7",
  muted: "#8e8e93",
  accent: "#f2f2f7",
  accentText: "#000000",
  accentSoft: "rgba(255, 255, 255, 0.1)",
  logoTile: "#2c2c30",
  logoFill: "#55529a",
  live: "#30d158",
  warn: "#ff9f0a",
  danger: "#ff453a",
  hudBg: "rgba(28, 28, 30, 0.82)",
};
