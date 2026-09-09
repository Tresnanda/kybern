import { useState } from "react";
import {
  Platform,
  Pressable,
  Switch as NativeSwitch,
  type SwitchProps,
} from "react-native";
import Animated, {
  cubicBezier,
  useReducedMotion,
} from "react-native-reanimated";
import { useTheme } from "./theme";

export function Toggle(props: SwitchProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  if (Platform.OS === "ios") return <NativeSwitch {...props} />;
  const {
    value = false,
    disabled,
    onValueChange,
    accessibilityLabel,
    testID,
  } = props;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      testID={testID}
      disabled={disabled}
      onPress={() => onValueChange?.(!value)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={{
        minWidth: 56,
        minHeight: 48,
        justifyContent: "center",
        opacity: disabled ? 0.38 : 1,
      }}
    >
      <Animated.View
        style={{
          width: 52,
          height: 30,
          borderRadius: 15,
          backgroundColor: value ? colors.ink : colors.raised,
          borderWidth: 1,
          borderColor: value ? colors.ink : colors.line,
          transitionProperty: "backgroundColor",
          transitionDuration: 140,
        }}
      >
        <Animated.View
          style={{
            position: "absolute",
            left: 3,
            top: 3,
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: value ? colors.inverse : colors.secondary,
            transform: [
              { translateX: value ? 22 : 0 },
              { scaleX: pressed && !reduced ? 1.15 : 1 },
              { scaleY: pressed && !reduced ? 0.9 : 1 },
            ],
            transitionProperty: ["transform", "backgroundColor"],
            transitionDuration: reduced ? 0 : 160,
            transitionTimingFunction: cubicBezier(0.23, 1, 0.32, 1),
          }}
        />
      </Animated.View>
    </Pressable>
  );
}
