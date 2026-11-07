import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { useTheme } from "./theme";
/** The update's activity is paint-only, and pauses with the screen or app. */
export function UpdateDot({ busy, failed }: { busy: boolean; failed: boolean }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => { const sub = AppState.addEventListener("change", state => setForeground(state === "active")); return () => sub.remove(); }, []);
  return <Animated.View accessible={false} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: failed ? colors.negative : busy ? colors.accent : colors.muted,
    animationName: { "0%": { opacity: 1 }, "50%": { opacity: 0.45 }, "100%": { opacity: 1 } }, animationDuration: 1600, animationIterationCount: "infinite", animationTimingFunction: "ease-in-out", animationPlayState: busy && !reduced && foreground && focused ? "running" : "paused" }} />;
}
