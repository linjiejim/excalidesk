export interface ThemeColors {
  dark: boolean;
  bg: string;
  surface: string;
  card: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  live: string;
  warn: string;
  danger: string;
  hudBg: string;
}

export const LIGHT_THEME: ThemeColors = {
  dark: false,
  bg: "#f4f4f2",
  surface: "#ffffff",
  card: "#ffffff",
  border: "rgba(0, 0, 0, 0.08)",
  text: "#1d1d1f",
  muted: "#6e6e73",
  accent: "#6965db",
  accentSoft: "rgba(105, 101, 219, 0.12)",
  live: "#2f9e44",
  warn: "#d97706",
  danger: "#d1453b",
  hudBg: "rgba(255, 255, 255, 0.92)",
};

export const DARK_THEME: ThemeColors = {
  dark: true,
  bg: "#121214",
  surface: "#1c1c1e",
  card: "#1e1e21",
  border: "rgba(255, 255, 255, 0.1)",
  text: "#f2f2f5",
  muted: "#98989f",
  accent: "#a5a2ff",
  accentSoft: "rgba(165, 162, 255, 0.16)",
  live: "#69db7c",
  warn: "#fbbf24",
  danger: "#ff6b6b",
  hudBg: "rgba(28, 28, 30, 0.92)",
};
