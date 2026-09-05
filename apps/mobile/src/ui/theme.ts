// Design tokens. Ink on paper: one neutral ramp, status colors are the only
// saturated colors on screen, and the orange Full access accent matches the
// desktop app. Type follows the iOS text styles so Dynamic Type math holds.

import { Platform, useColorScheme } from "react-native";

export interface Theme {
  dark: boolean;
  /** Page background under the ambient gradient. */
  canvas: string;
  /** Second stop of the ambient gradient. */
  canvasDeep: string;
  /** Flat surface (cards that do not float). */
  surface: string;
  surfaceRaised: string;
  hairline: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  /** Primary action fill: ink in light, paper in dark. */
  ink: string;
  onInk: string;
  running: string;
  waiting: string;
  failed: string;
  completed: string;
  fullAccess: string;
  /** Fallback glass fill when Liquid Glass is unavailable. */
  glassFill: string;
  glassBorder: string;
  /** Quiet fill for the user's own messages. */
  bubble: string;
  codeFill: string;
}

export const light: Theme = {
  dark: false,
  canvas: "#F6F6F7",
  canvasDeep: "#E6E6EB",
  surface: "rgba(255,255,255,0.72)",
  surfaceRaised: "rgba(17,17,20,0.06)",
  hairline: "rgba(17,17,20,0.10)",
  text: "#121215",
  textSecondary: "#66666F",
  textTertiary: "#9A9AA3",
  ink: "#121215",
  onInk: "#FFFFFF",
  running: "#2F7CF6",
  waiting: "#D98F0C",
  failed: "#D94A3A",
  completed: "#2E9E5B",
  fullAccess: "#E8590C",
  glassFill: "rgba(255,255,255,0.55)",
  glassBorder: "rgba(17,17,20,0.09)",
  bubble: "rgba(17,17,20,0.06)",
  codeFill: "rgba(17,17,20,0.05)",
};

export const dark: Theme = {
  dark: true,
  canvas: "#101013",
  canvasDeep: "#08080A",
  surface: "rgba(255,255,255,0.06)",
  surfaceRaised: "rgba(255,255,255,0.10)",
  hairline: "rgba(255,255,255,0.10)",
  text: "#F2F2F4",
  textSecondary: "#A3A3AB",
  textTertiary: "#6E6E77",
  ink: "#F2F2F4",
  onInk: "#111114",
  running: "#5A9CFF",
  waiting: "#E6A32E",
  failed: "#EF6A5B",
  completed: "#4FBF7A",
  fullAccess: "#F0722A",
  glassFill: "rgba(28,28,32,0.55)",
  glassBorder: "rgba(255,255,255,0.12)",
  bubble: "rgba(255,255,255,0.08)",
  codeFill: "rgba(255,255,255,0.06)",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/** iOS text styles (default content size). */
export const type = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: "700" as const, letterSpacing: 0.4 },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: "700" as const, letterSpacing: 0.36 },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: "700" as const, letterSpacing: 0.35 },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: "600" as const, letterSpacing: 0.38 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: "600" as const, letterSpacing: -0.41 },
  body: { fontSize: 17, lineHeight: 22, letterSpacing: -0.41 },
  transcript: { fontSize: 17, lineHeight: 26, letterSpacing: -0.41 },
  callout: { fontSize: 16, lineHeight: 21, letterSpacing: -0.32 },
  subhead: { fontSize: 15, lineHeight: 20, letterSpacing: -0.24 },
  footnote: { fontSize: 13, lineHeight: 18, letterSpacing: -0.08 },
  caption: { fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
  monoSmall: { fontFamily: mono, fontSize: 12, lineHeight: 17 },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
/** Concentric: outer = inner + padding. */
export const radius = { sm: 8, md: 12, lg: 18, xl: 24, pill: 999 };

/** Screen gutter shared by every surface so edges line up. */
export const GUTTER = 20;
