import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  View,
  type ActivityIndicatorProps,
} from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { useTheme } from "./theme";

const pulse = {
  "0%": { transform: [{ scaleY: 0.55 }], opacity: 0.45 },
  "50%": { transform: [{ scaleY: 1 }], opacity: 1 },
  "100%": { transform: [{ scaleY: 0.55 }], opacity: 0.45 },
};
export function Busy(props: ActivityIndicatorProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => sub.remove();
  }, []);
  if (Platform.OS === "ios") return <ActivityIndicator {...props} />;
  if (props.animating === false && props.hidesWhenStopped !== false)
    return null;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={props.accessibilityLabel ?? "Loading"}
      style={[
        {
          width: 22,
          height: 22,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
        },
        props.style,
      ]}
    >
      {[0, 1, 2].map((index) => (
        <Animated.View
          key={index}
          style={{
            width: 3,
            height: index === 1 ? 16 : 11,
            borderRadius: 3,
            backgroundColor: props.color ?? colors.ink,
            animationName: pulse,
            animationDuration: 1200,
            animationDelay: index * 160,
            animationIterationCount: "infinite",
            animationTimingFunction: "ease-in-out",
            animationPlayState:
              reduced || !foreground || props.animating === false
                ? "paused"
                : "running",
          }}
        />
      ))}
    </View>
  );
}
