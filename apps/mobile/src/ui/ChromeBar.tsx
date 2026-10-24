// ChromeBar: the contract for floating top and bottom chrome on custom screens
// (the thread screen first). A bar owns its material, pads the safe area,
// measures itself and publishes its height, so the list underneath insets its
// content instead of guessing. Content scrolls under the material only;
// interactive chrome always sits on it.
//
// The material hugs the screen edge like iOS 26's scroll edge effect:
//   bottom   clear at the bar's top edge, solid EDGE_FADE (24 pt) into the bar,
//            so content stays sharp right up to the bar and dissolves under its
//            first row (chips, capsules), never above it.
//   top      solid over the status bar and header, dissolving over TOP_FADE
//            (12 pt) just below the header.
//   iOS      system chrome blur + `chrome` tint through that mask (100 %
//            `background` with Reduce Transparency). The top bar's material
//            fades in over the first 8 pt of scroll, on the UI thread.
//   Android  `background` through the same ramp (no blur to sample).
import MaskedView from "@react-native-masked-view/masked-view";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import {
  AccessibilityInfo,
  Dimensions,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./theme";

/** How far into a bottom bar its material takes to become solid. */
export const EDGE_FADE = 24;
/** How far below a top bar its material takes to dissolve. */
export const TOP_FADE = 12;
// Eased ramp: the first points stay nearly clear so text is not veiled early.
const RAMP_STOPS = [0, 0.35, 0.7, 1] as const;

/** iOS "Reduce Transparency": draw bars opaque. */
export function useReduceTransparency() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setReduced);
    const sub = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduced);
    return () => sub.remove();
  }, []);
  return reduced;
}

/**
 * Leading space the iPadOS window controls (● ● ●) take in a custom header.
 * Native stack headers handle this themselves. Until a native module can read
 * the corner-adaptive margins, a windowed iPad (window narrower than the
 * screen) reserves 78 pt (ux-thread H11).
 */
export function useWindowControlsInset() {
  const { width } = useWindowDimensions();
  if (Platform.OS !== "ios" || !Platform.isPad) return 0;
  return width < Dimensions.get("screen").width - 1 ? 78 : 0;
}

type Heights = { top: number; bottom: number };
const ChromeContext = createContext<{
  heights: Heights;
  publish: (edge: keyof Heights, height: number) => void;
}>({ heights: { top: 0, bottom: 0 }, publish: () => {} });

/** Wrap a screen that uses ChromeBars; lists read the heights with `useChromeInsets`. */
export function ChromeProvider({ children }: PropsWithChildren) {
  const [heights, setHeights] = useState<Heights>({ top: 0, bottom: 0 });
  const publish = useCallback((edge: keyof Heights, height: number) => {
    const rounded = Math.round(height);
    setHeights((old) => (old[edge] === rounded ? old : { ...old, [edge]: rounded }));
  }, []);
  const value = useMemo(() => ({ heights, publish }), [heights, publish]);
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}

/**
 * The measured bar heights (safe areas included). Use them as the list's
 * content inset; when a bar grows (a status strip appears), adjust the list by
 * the delta in the same frame rather than animating the list.
 */
export function useChromeInsets() {
  return useContext(ChromeContext).heights;
}

export function ChromeBar({
  edge,
  scrollY,
  tone = "background",
  avoidWindowControls = true,
  safeArea = true,
  style,
  children,
}: PropsWithChildren<{
  edge: "top" | "bottom";
  /** The list's scroll offset: the top bar reveals its material over the first 8 pt. */
  scrollY?: SharedValue<number>;
  /** The page colour the material dissolves into (`grouped` on settings-style pages). */
  tone?: "background" | "grouped";
  /** Top bars on iPad keep clear of the window controls. */
  avoidWindowControls?: boolean;
  /** Pad the screen's safe area (off for bars inside a smaller frame). */
  safeArea?: boolean;
  style?: StyleProp<ViewStyle>;
}>) {
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceTransparency = useReduceTransparency();
  const windowControls = useWindowControlsInset();
  const { publish } = useContext(ChromeContext);
  const top = edge === "top";
  const reveal = useAnimatedStyle(() => {
    if (!top || !scrollY) return { opacity: 1 };
    return { opacity: interpolate(scrollY.get(), [0, 8], [0, 1], "clamp") };
  });
  const ios = Platform.OS === "ios";
  const fill = ios ? (
    reduceTransparency ? (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors[tone] }]} />
    ) : (
      <>
        <BlurView
          intensity={80}
          tint={dark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.chrome }]} />
      </>
    )
  ) : null;
  // One mask for both platforms: solid over the bar, an eased ramp on its
  // content side (inside a bottom bar, just past a top bar).
  const fadeLength = top ? TOP_FADE : EDGE_FADE;
  const ramp = (color: string) => (
    <LinearGradient
      colors={[`${color}00`, `${color}40`, `${color}B8`, `${color}FF`]}
      locations={RAMP_STOPS}
      start={{ x: 0, y: top ? 1 : 0 }}
      end={{ x: 0, y: top ? 0 : 1 }}
      style={{ height: fadeLength }}
    />
  );
  const shape = (color: string) => (
    <View style={{ flex: 1 }}>
      {!top && ramp(color)}
      <View style={{ flex: 1, backgroundColor: color }} />
      {top && ramp(color)}
    </View>
  );
  const region = {
    position: "absolute" as const,
    start: 0,
    end: 0,
    top: 0,
    bottom: top ? -TOP_FADE : 0,
  };
  const material = fill ? (
    <MaskedView pointerEvents="none" style={region} maskElement={shape("#000000")}>
      {fill}
    </MaskedView>
  ) : (
    <View pointerEvents="none" style={region}>
      {shape(colors[tone].slice(0, 7))}
    </View>
  );
  return (
    <View
      pointerEvents="box-none"
      onLayout={(e) => publish(edge, e.nativeEvent.layout.height)}
      style={[
        {
          position: "absolute",
          start: 0,
          end: 0,
          [edge]: 0,
          paddingTop: top && safeArea ? insets.top : 0,
          paddingBottom: !top && safeArea ? insets.bottom : 0,
          paddingStart: top && avoidWindowControls ? windowControls : 0,
        },
        style,
      ]}
    >
      {/* Top bars start clear and fill as content scrolls under them. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, top ? reveal : null]}>
        {material}
      </Animated.View>
      {children}
    </View>
  );
}
