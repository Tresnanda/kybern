import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";
import {
  Appearance as NativeAppearance,
  Platform,
  useColorScheme,
} from "react-native";

// Ink palette. `background` is a plain page, `grouped` a settings-style page
// behind `surface` groups, `raised` a control fill (fields, chips, pressed rows).
// `card` lifts a block off `background` where `surface` would not show.
const light = {
  background: "#FFFFFF",
  grouped: "#F2F2F7",
  surface: "#FFFFFF",
  card: "#F4F4F5",
  raised: "#F2F2F2",
  ink: "#1A1C1F",
  secondary: "#666666",
  muted: "#777777",
  line: "#E5E5E5",
  inverse: "#FFFFFF",
  accent: "#0969DA",
  accentSoft: "#EAF3FF",
  /** The one commit button per screen. Never pure white in dark mode. */
  prominent: "#1A1C1F",
  onProminent: "#FFFFFF",
  positive: "#008A38",
  negative: "#BA2623",
  negativeSoft: "#FCEBEA",
  warning: "#856014",
  warningSoft: "#FAF2DF",
  code: "#F5F5F5",
  /** Dialog backdrop. Sheets use `scrim` (32 %), menus `scrimLight` (20 %). */
  backdrop: "#00000066",
  scrim: "#00000052",
  scrimLight: "#00000033",
  /** Bar tint over blur (iOS) and the opaque bar fill (Android). */
  chrome: "#FFFFFFB8",
};
const dark: typeof light = {
  background: "#181818",
  grouped: "#111111",
  surface: "#202020",
  card: "#232325",
  raised: "#2B2B2B",
  ink: "#FFFFFF",
  secondary: "#B3B3B3",
  muted: "#999999",
  line: "#333333",
  inverse: "#181818",
  accent: "#339CFF",
  accentSoft: "#203247",
  prominent: "#E9E9EB",
  onProminent: "#141414",
  positive: "#40C977",
  negative: "#FA423E",
  negativeSoft: "#3A2222",
  warning: "#DFBD7C",
  warningSoft: "#383024",
  code: "#222222",
  backdrop: "#00000088",
  scrim: "#00000052",
  scrimLight: "#00000033",
  chrome: "#181818B8",
};
export type Colors = typeof light;
export type ColorToken = keyof Colors;
export type Appearance = "system" | "light" | "dark";
const ThemeContext = createContext({
  colors: light,
  dark: false,
  appearance: "system" as Appearance,
  setAppearance: (_: Appearance) => {},
});
export function ThemeProvider({ children }: PropsWithChildren) {
  const system = useColorScheme();
  const [appearance, updateAppearance] = useState<Appearance>("system");
  useEffect(() => {
    if (Platform.OS !== "web")
      void SecureStore.getItemAsync("kybern.ink.appearance")
        .then((value) => {
          if (value === "system" || value === "light" || value === "dark")
            updateAppearance(value);
        })
        .catch(() => {});
  }, []);
  useEffect(() => {
    NativeAppearance.setColorScheme(
      appearance === "system" ? "unspecified" : appearance,
    );
  }, [appearance]);
  const setAppearance = (value: Appearance) => {
    updateAppearance(value);
    if (Platform.OS !== "web")
      void SecureStore.setItemAsync("kybern.ink.appearance", value).catch(
        () => {},
      );
  };
  const isDark =
    appearance === "dark" || (appearance === "system" && system === "dark");
  return (
    <ThemeContext.Provider
      value={{
        colors: isDark ? dark : light,
        dark: isDark,
        appearance,
        setAppearance,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
export const useTheme = () => useContext(ThemeContext);

/**
 * Spacing. Within a group items sit `sm` apart; groups sit `2xl` apart (at least
 * twice the inner gap). Single-line rows pad 11 vertically (44 pt), rows with a
 * subtitle 10. Use `gutter()` for the page edge.
 */
export const space = {
  "2xs": 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
  "3xl": 48,
} as const;
/** Page side margin: 16 on phones, 24 once the content column is 600 pt wide. */
export const gutter = (width: number) => (width >= 600 ? space.xl : space.lg);
/** Readable content column. */
export const CONTENT_MAX_WIDTH = 760;

/**
 * Corner radii. Nested surfaces are concentric: inner = outer − padding (a menu
 * row inside a `lg` menu with 6 pt padding is `md`). Never use other values.
 */
export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  full: 999,
} as const;

/** Monospace for commands, paths, branches, code: SF Mono on iOS, Roboto Mono-ish on Android. */
export const MONO = Platform.select({ ios: "ui-monospace", default: "monospace" });

/**
 * Type scale. Sizes are iOS Dynamic Type "Large" defaults and Android sp; text
 * scales with the system setting (see `T` for the per-role ceilings).
 * iOS style → Android M3 role:
 *   largeTitle Large Title → headlineMedium · title Title 2 → titleLarge ·
 *   headline Headline → titleMedium · body Body → bodyLarge · callout Callout →
 *   bodyLarge · subhead Subheadline → bodyMedium · footnote Footnote → bodySmall ·
 *   sectionHeader Footnote semibold → labelLarge · caption Caption 1 → labelMedium.
 */
const scale = {
  largeTitle: { fontSize: 34, lineHeight: 41, letterSpacing: -0.4, fontWeight: "700" },
  title: { fontSize: 22, lineHeight: 28, letterSpacing: -0.3, fontWeight: "600" },
  headline: { fontSize: 17, lineHeight: 22, letterSpacing: -0.2, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 24, letterSpacing: -0.2, fontWeight: "400" },
  /** Long-form reading (assistant answers, note bodies): body with more leading. */
  prose: { fontSize: 17, lineHeight: 26, letterSpacing: -0.2, fontWeight: "400" },
  callout: { fontSize: 16, lineHeight: 21, letterSpacing: -0.1, fontWeight: "400" },
  subhead: { fontSize: 15, lineHeight: 20, letterSpacing: -0.1, fontWeight: "400" },
  /** Control labels: buttons, chips, segmented items. */
  label: { fontSize: 15, lineHeight: 20, letterSpacing: -0.1, fontWeight: "500" },
  footnote: { fontSize: 13, lineHeight: 18, letterSpacing: 0, fontWeight: "400" },
  sectionHeader: { fontSize: 13, lineHeight: 18, letterSpacing: 0, fontWeight: "600" },
  caption: { fontSize: 12, lineHeight: 16, letterSpacing: 0, fontWeight: "400" },
  /** Inline machine text in rows: commands, paths, branches. */
  code: { fontSize: 13, lineHeight: 18, letterSpacing: 0, fontFamily: MONO, fontWeight: "400" },
  /** Blocks of code and terminal-like output. */
  mono: { fontSize: 13, lineHeight: 20, letterSpacing: 0, fontFamily: MONO, fontWeight: "400" },
} as const;
export const type = {
  ...scale,
  /** @deprecated Use `largeTitle`. */
  display: scale.largeTitle,
  /** @deprecated Use `headline`. */
  heading: scale.headline,
} as const;
export type TypeRole = keyof typeof type;
/** Dynamic Type ceiling per role: rows and titles stop at 160 %, reading text at 200 %. */
export const maxScale = (role: TypeRole) =>
  role === "body" || role === "prose" || role === "callout" ? 2 : 1.6;
