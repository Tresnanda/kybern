// A few mutually exclusive values on one capsule track; the chosen value sits on
// a raised thumb that slides between segments. Used for list scopes ("All /
// Working / Pinned / Archived") and short settings choices. The same themed
// control on both platforms (no stock Android tabs); every segment is a 44 pt
// target even when `compact` draws a 32 pt track.
import { useState } from "react";
import { View, type LayoutRectangle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  withSpring,
} from "react-native-reanimated";
import { RECOIL } from "../components/liquid/motion";
import { haptics } from "./haptics";
import { T, Tap } from "./primitives";
import { radius, useTheme } from "./theme";

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  disabled,
  label,
  compact = false,
}: {
  options: readonly { value: V; label: string }[];
  value: V;
  onChange: (value: V) => void;
  disabled?: boolean;
  /** What the control chooses, for screen readers ("Show threads"). */
  label: string;
  /** 32 pt track for list filters under a header. */
  compact?: boolean;
}) {
  const { colors, dark } = useTheme();
  const reduced = useReducedMotion();
  const [frames, setFrames] = useState<Record<string, LayoutRectangle>>({});
  const frame = frames[value];
  const height = compact ? 32 : 40;
  // The thumb is absolute and childless: moving and resizing it never
  // re-lays-out the labels.
  const thumb = useAnimatedStyle(() =>
    frame
      ? {
          opacity: 1,
          width: reduced ? frame.width : withSpring(frame.width, RECOIL),
          transform: [{ translateX: reduced ? frame.x : withSpring(frame.x, RECOIL) }],
        }
      : { opacity: 0 },
  );
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        padding: 2,
        borderRadius: radius.full,
        backgroundColor: colors.raised,
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            top: 2,
            left: 0,
            height,
            borderRadius: radius.full,
            backgroundColor: dark ? colors.line : colors.surface,
            boxShadow: dark ? undefined : "0 1px 3px #0000001A",
          },
          thumb,
        ]}
      />
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <View
            key={option.value}
            style={{ flex: 1 }}
            onLayout={(e) => {
              const layout = { ...e.nativeEvent.layout, x: e.nativeEvent.layout.x };
              setFrames((old) => {
                const prev = old[option.value];
                return prev && prev.x === layout.x && prev.width === layout.width
                  ? old
                  : { ...old, [option.value]: layout };
              });
            }}
          >
            <Tap
              label={option.label}
              selected={selected}
              disabled={disabled}
              feedback="none"
              hitSlop={compact ? { top: 6, bottom: 6 } : undefined}
              onPress={() => {
                if (selected) return;
                if (!compact) haptics.select();
                onChange(option.value);
              }}
              style={{
                minHeight: height,
                paddingHorizontal: compact ? 10 : 8,
                alignItems: "center",
              }}
            >
              <T
                variant={compact ? "footnote" : "subhead"}
                tone={selected ? "ink" : "secondary"}
                numberOfLines={1}
                // At the larger text sizes a label shrinks to its segment rather than truncating.
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                style={selected ? { fontWeight: "600" } : undefined}
              >
                {option.label}
              </T>
            </Tap>
          </View>
        );
      })}
    </View>
  );
}
