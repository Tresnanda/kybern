// Pressable with feedback on press-in: scale to 0.96 on the UI thread, optional
// haptic on commit. Every tappable surface in the app goes through this.

import React from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Haptic = "light" | "medium" | "selection" | "success" | "error" | false;

interface Props extends Omit<PressableProps, "style"> {
  style?: StyleProp<ViewStyle>;
  /** How far the surface sinks. 1 disables the scale. */
  scale?: number;
  haptic?: Haptic;
  children?: React.ReactNode;
}

export function fireHaptic(kind: Haptic) {
  if (!kind) return;
  switch (kind) {
    case "light":
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      break;
    case "medium":
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      break;
    case "selection":
      void Haptics.selectionAsync();
      break;
    case "success":
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      break;
    case "error":
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      break;
  }
}

export function Tap({ scale = 0.96, haptic = false, onPress, onPressIn, onPressOut, style, children, disabled, ...rest }: Props) {
  const pressed = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.get() * (1 - scale) }],
  }));
  return (
    <AnimatedPressable
      accessibilityRole="button"
      disabled={disabled}
      pressRetentionOffset={12}
      onPressIn={(e) => {
        pressed.set(withSpring(1, { duration: 120, dampingRatio: 1 }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        pressed.set(withSpring(0, { duration: 220, dampingRatio: 1 }));
        onPressOut?.(e);
      }}
      onPress={(e) => {
        fireHaptic(haptic);
        onPress?.(e);
      }}
      style={[animated, style, disabled ? { opacity: 0.45 } : null]}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}
