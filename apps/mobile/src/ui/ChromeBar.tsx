// ChromeBar: the contract for floating top and bottom chrome on custom screens
// (the thread screen first). A bar owns its material, pads the safe area,
// measures itself and publishes its height, so the list underneath insets its
// content instead of guessing. Content scrolls under the material only;
// interactive chrome always sits on it.
//
//   iOS      system chrome blur + `chrome` tint (100 % `background` with Reduce
//            Transparency). The top bar's material fades in over the first 8 pt
//            of scroll, driven on the UI thread.
//   Android  opaque `background`, a 12 pt scroll-edge gradient on the content
//            side, and a hairline once content is underneath.
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
  contentUnder = true,
  avoidWindowControls = true,
  safeArea = true,
  style,
  children,
}: PropsWithChildren<{
  edge: "top" | "bottom";
  /** The list's scroll offset: the top bar reveals its material over the first 8 pt. */
  scrollY?: SharedValue<number>;
  /** Whether content currently sits under a bottom bar (shows its edge). */
  contentUnder?: boolean;
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
  const material = ios ? (
    reduceTransparency ? (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} />
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
  ) : (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} />
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
      {/* iOS top bars start clear and fill as content scrolls under them;
          Android bars are always opaque, so only their edge reacts. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, ios && top ? reveal : null]}
      >
        {material}
      </Animated.View>
      {!ios && (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              start: 0,
              end: 0,
              height: 12,
              ...(top ? { top: "100%" } : { bottom: "100%" }),
            },
            top ? reveal : { opacity: contentUnder ? 1 : 0 },
          ]}
        >
          <LinearGradient
            colors={[colors.background, `${colors.background}00`]}
            start={{ x: 0, y: top ? 0 : 1 }}
            end={{ x: 0, y: top ? 1 : 0 }}
            style={StyleSheet.absoluteFill}
          />
          <View
            style={{
              position: "absolute",
              start: 0,
              end: 0,
              [top ? "top" : "bottom"]: 0,
              height: StyleSheet.hairlineWidth,
              backgroundColor: colors.line,
            }}
          />
        </Animated.View>
      )}
      {children}
    </View>
  );
}
