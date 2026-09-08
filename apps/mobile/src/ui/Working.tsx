import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { T } from "./primitives";
import { useTheme } from "./theme";
const pulse = {
  "0%": { opacity: 0.3, transform: [{ scaleY: 0.55 }] },
  "50%": { opacity: 1, transform: [{ scaleY: 1 }] },
  "100%": { opacity: 0.3, transform: [{ scaleY: 0.55 }] },
};
export function Working({
  label = "Working",
  active = true,
}: {
  label?: string;
  active?: boolean;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) =>
      setForeground(s === "active"),
    );
    return () => sub.remove();
  }, []);
  return (
    <View
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
    >
      <View
        style={{
          height: 18,
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
        }}
      >
        {[0, 1, 2].map((i) => (
          <Animated.View
            key={i}
            style={{
              width: 3,
              height: i === 1 ? 15 : 10,
              borderRadius: 2,
              backgroundColor: colors.accent,
              animationName: pulse,
              animationDuration: 1200,
              animationDelay: i * 160,
              animationIterationCount: "infinite",
              animationTimingFunction: "ease-in-out",
              animationPlayState:
                reduced || !foreground || !active ? "paused" : "running",
            }}
          />
        ))}
      </View>
      <T variant="caption" tone="accent">
        {label}
      </T>
    </View>
  );
}
