// Theme tokens. Status colors are the only saturated colors on screen.

import { useColorScheme } from "react-native";

export interface Theme {
  dark: boolean;
  canvas: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  onAccent: string;
  running: string;
  waiting: string;
  failed: string;
  completed: string;
  focus: string;
}

export const light: Theme = {
  dark: false,
  canvas: "#ffffff",
  surface: "#f5f5f6",
  surfaceRaised: "#ececee",
  border: "#e3e3e6",
  text: "#111114",
  textSecondary: "#5c5c66",
  textTertiary: "#8a8a94",
  accent: "#111114",
  onAccent: "#ffffff",
  running: "#2f7cf6",
  waiting: "#d9900c",
  failed: "#d94a3a",
  completed: "#2e9e5b",
  focus: "#2f7cf6",
};

export const dark: Theme = {
  dark: true,
  canvas: "#111113",
  surface: "#1b1b1f",
  surfaceRaised: "#25252a",
  border: "#2b2b31",
  text: "#f0f0f2",
  textSecondary: "#a2a2ab",
  textTertiary: "#6f6f78",
  accent: "#f0f0f2",
  onAccent: "#111113",
  running: "#5a9cff",
  waiting: "#e6a32e",
  failed: "#ef6a5b",
  completed: "#4fbf7a",
  focus: "#5a9cff",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

/** System font, sizes from docs/design.md. */
export const type = {
  body: { fontSize: 15, lineHeight: 22 },
  transcript: { fontSize: 15, lineHeight: 24 },
  sidebar: { fontSize: 15, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 16 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "600" as const },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "600" as const },
  mono: { fontFamily: "Menlo", fontSize: 13, lineHeight: 19 },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 6, md: 10, lg: 14 };
