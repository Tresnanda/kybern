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

const light = {
  background: "#FFFFFF",
  surface: "#FFFFFF",
  raised: "#F2F2F2",
  ink: "#1A1C1F",
  secondary: "#666666",
  muted: "#777777",
  line: "#E5E5E5",
  inverse: "#FFFFFF",
  accent: "#0969DA",
  accentSoft: "#EAF3FF",
  positive: "#008A38",
  negative: "#BA2623",
  warning: "#856014",
  warningSoft: "#FAF2DF",
  code: "#F5F5F5",
  backdrop: "#00000066",
};
const dark: typeof light = {
  background: "#181818",
  surface: "#202020",
  raised: "#2B2B2B",
  ink: "#FFFFFF",
  secondary: "#B3B3B3",
  muted: "#999999",
  line: "#373737",
  inverse: "#181818",
  accent: "#339CFF",
  accentSoft: "#203247",
  positive: "#40C977",
  negative: "#FA423E",
  warning: "#DFBD7C",
  warningSoft: "#383024",
  code: "#222222",
  backdrop: "#00000088",
};
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
export const space = { xs: 4, sm: 8, md: 12, lg: 20, xl: 28, xxl: 40 };
export const type = {
  display: {
    fontSize: 40,
    lineHeight: 45,
    letterSpacing: -1.8,
    fontWeight: "400",
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.8,
    fontWeight: "500",
  },
  heading: {
    fontSize: 20,
    lineHeight: 27,
    letterSpacing: -0.4,
    fontWeight: "600",
  },
  body: { fontSize: 17, lineHeight: 26, fontWeight: "400" },
  label: { fontSize: 15, lineHeight: 21, fontWeight: "500" },
  caption: { fontSize: 13, lineHeight: 19, fontWeight: "400" },
  mono: {
    fontSize: 13,
    lineHeight: 21,
    fontFamily: "Menlo",
    fontWeight: "400",
  },
} as const;
