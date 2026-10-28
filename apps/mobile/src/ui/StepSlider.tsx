// A few ordered steps on a line (text size): a tick per step and a round thumb
// that springs to the chosen one. Tap a tick or drag along the line. The same
// themed control on both platforms (no stock Android slider); the whole row is
// a 44 pt target and VoiceOver/TalkBack adjust it one step at a time.
import { useRef, useState, type ReactNode } from "react";
import { View, type GestureResponderEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  withSpring,
} from "react-native-reanimated";
import { RECOIL } from "../components/liquid/motion";
import { haptics } from "./haptics";
import { radius, useTheme } from "./theme";

const THUMB = 26;
const TICK = 8;

export function StepSlider({
  steps,
  index,
  onChange,
  label,
  valueText,
  leading,
  trailing,
}: {
  steps: number;
  index: number;
  onChange: (index: number) => void;
  /** What the control sets, for screen readers ("Text size"). */
  label: string;
  /** The current step read aloud ("110%"). */
  valueText: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const { colors, dark } = useTheme();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const last = useRef(index);
  last.current = index;
  // The thumb's centre travels between the first and last tick centres.
  const span = Math.max(0, width - THUMB);
  const at = (i: number) => (steps > 1 ? (span * i) / (steps - 1) : 0);
  const x = at(index);
  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: reduced ? x : withSpring(x, RECOIL) }],
  }));
  const pick = (event: GestureResponderEvent) => {
    if (!span) return;
    const ratio = (event.nativeEvent.locationX - THUMB / 2) / span;
    const next = Math.min(steps - 1, Math.max(0, Math.round(ratio * (steps - 1))));
    if (next === last.current) return;
    last.current = next;
    haptics.select();
    onChange(next);
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
      {leading}
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: valueText }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => {
          const next = index + (event.nativeEvent.actionName === "increment" ? 1 : -1);
          if (next >= 0 && next < steps) onChange(next);
        }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        // Keep the drag when the page would like to scroll.
        onResponderTerminationRequest={() => false}
        onResponderGrant={pick}
        onResponderMove={pick}
        style={{ flex: 1, height: 44, justifyContent: "center" }}
      >
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: THUMB / 2,
            right: THUMB / 2,
            height: 2,
            borderRadius: 1,
            backgroundColor: colors.line,
          }}
        />
        {Array.from({ length: steps }, (_, i) => (
          <View
            key={i}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: at(i) + (THUMB - TICK) / 2,
              width: TICK,
              height: TICK,
              borderRadius: radius.full,
              backgroundColor: colors.line,
            }}
          />
        ))}
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: 0,
              width: THUMB,
              height: THUMB,
              borderRadius: radius.full,
              opacity: width ? 1 : 0,
              backgroundColor: dark ? colors.prominent : colors.surface,
              boxShadow: dark ? undefined : "0 1px 4px #00000033, 0 0 0 0.5px #0000000F",
            },
            thumb,
          ]}
        />
      </View>
      {trailing}
    </View>
  );
}
