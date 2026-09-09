import { useEffect, useState, type PropsWithChildren } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "../../ui/theme";
import { MASS, SIZE } from "./motion";

export function MorphingBackdrop({
  open,
  onPress,
  label,
}: {
  open: boolean;
  onPress: () => void;
  label?: string;
}) {
  const { colors } = useTheme();
  const fade = useSharedValue(0);
  useEffect(() => {
    fade.set(
      withTiming(open ? 1 : 0, {
        duration: 140,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [open, fade]);
  const style = useAnimatedStyle(() => ({ opacity: fade.get() }));
  return (
    <Pressable
      accessible={Boolean(label)}
      accessibilityRole={label ? "button" : undefined}
      accessibilityLabel={label}
      onPress={onPress}
      style={StyleSheet.absoluteFill}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: colors.backdrop },
          style,
        ]}
      />
    </Pressable>
  );
}

// The same leading mass / following size as the ellipsis menu. Only the empty
// silhouette changes dimensions; text lays out once at its final size.
export function MorphingSurface({
  open,
  onClosed,
  children,
  style,
}: PropsWithChildren<{
  open: boolean;
  onClosed: () => void;
  style?: StyleProp<ViewStyle>;
}>) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const mass = useSharedValue(0);
  const size = useSharedValue(0);
  const fade = useSharedValue(0);
  useEffect(() => {
    if (!bounds.width || !bounds.height) return;
    mass.set(withSpring(open ? 1 : 0, MASS));
    size.set(
      withSpring(open ? 1 : 0, SIZE, (finished) => {
        if (finished && !open && !reduced) scheduleOnRN(onClosed);
      }),
    );
    fade.set(
      withTiming(
        open ? 1 : 0,
        { duration: 140, reduceMotion: ReduceMotion.Never },
        (finished) => {
          if (finished && !open && reduced) scheduleOnRN(onClosed);
        },
      ),
    );
  }, [open, bounds.width, bounds.height, reduced, mass, size, fade, onClosed]);
  const silhouette = useAnimatedStyle(() => {
    const p = reduced ? 1 : size.get();
    const c = reduced ? 1 : mass.get();
    const width = 56 + (bounds.width - 56) * p;
    const height = 44 + (bounds.height - 44) * p;
    const round = Math.sin(Math.PI * Math.max(0, Math.min(1, p)));
    return {
      width,
      height,
      borderRadius: Math.min(width / 2, height / 2, 28 + round * 48),
      opacity: fade.get(),
      transform: [
        { translateX: (bounds.width - width) / 2 },
        {
          translateY:
            (bounds.height - 22) * (1 - c) +
            (bounds.height / 2) * c -
            height / 2,
        },
      ],
    };
  });
  const content = useAnimatedStyle(() => ({
    opacity: reduced
      ? fade.get()
      : interpolate(size.get(), [0.7, 1], [0, 1], "clamp"),
  }));
  return (
    <View
      style={style}
      onLayout={({ nativeEvent: { layout } }) => {
        setBounds((old) =>
          old.width === layout.width && old.height === layout.height
            ? old
            : { width: layout.width, height: layout.height },
        );
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            left: 0,
            top: 0,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.line,
            boxShadow: "0 8px 36px #00000025",
          },
          silhouette,
        ]}
      />
      <Animated.View
        pointerEvents={open ? "auto" : "none"}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? "auto" : "no-hide-descendants"}
        style={[
          { flexGrow: 1, flexShrink: 1, borderRadius: 28, overflow: "hidden" },
          content,
        ]}
      >
        {children}
      </Animated.View>
    </View>
  );
}
