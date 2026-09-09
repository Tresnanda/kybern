import { useEffect, useRef, useState, type PropsWithChildren } from "react";
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
  type SharedValue,
  useDerivedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "../../ui/theme";
import { SHEET, SHEET_OUTLINE } from "./motion";

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

// Only measured controls use MorphingMenu. A source-less dialog fades in at
// its final bounds; a sheet comes from the screen edge and carries drag velocity.
export function MorphingSurface({
  open,
  onClosed,
  children,
  style,
  slideFromBottom = false,
  bottomInset = 0,
  offset: externalOffset,
  releaseVelocity,
}: PropsWithChildren<{
  open: boolean;
  onClosed: () => void;
  style?: StyleProp<ViewStyle>;
  slideFromBottom?: boolean;
  bottomInset?: number;
  offset?: SharedValue<number>;
  releaseVelocity?: SharedValue<number>;
}>) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const initialized = useRef(false);
  const ready = useSharedValue(false);
  const localOffset = useSharedValue(0);
  const offset = externalOffset ?? localOffset;
  const fade = useSharedValue(0);
  const distance = bounds.height + bottomInset + 32;
  const outlineOffset = useDerivedValue(() =>
    withSpring(offset.get(), SHEET_OUTLINE),
  );
  useEffect(() => {
    if (!bounds.width || !bounds.height) return;
    if (!initialized.current) {
      offset.set(slideFromBottom ? distance : 0);
      initialized.current = true;
      ready.set(true);
    }
    if (slideFromBottom) {
      offset.set(
        withSpring(
          open ? 0 : distance,
          {
            ...SHEET,
            velocity: releaseVelocity?.get() ?? 0,
            overshootClamping: !open,
          },
          (finished) => {
            if (finished && !open && !reduced) scheduleOnRN(onClosed);
          },
        ),
      );
    }
    fade.set(
      withTiming(
        open ? 1 : 0,
        {
          duration: 140,
          reduceMotion: ReduceMotion.Never,
        },
        (finished) => {
          if (finished && !open && (reduced || !slideFromBottom))
            scheduleOnRN(onClosed);
        },
      ),
    );
  }, [
    open,
    bounds.width,
    bounds.height,
    distance,
    slideFromBottom,
    reduced,
    offset,
    fade,
    releaseVelocity,
    ready,
    onClosed,
  ]);
  const rise = useAnimatedStyle(() => ({
    opacity: !ready.get() ? 0 : reduced || !slideFromBottom ? fade.get() : 1,
    transform: [{ translateY: reduced || !slideFromBottom ? 0 : offset.get() }],
  }));
  const silhouette = useAnimatedStyle(() => {
    // Difference between the leading mass and its following outline gives a
    // directional stretch, then a small recoil. The content stays unscaled.
    const lag =
      reduced || !slideFromBottom
        ? 0
        : Math.max(
            -24,
            Math.min(40, (outlineOffset.get() - offset.get()) * 0.12),
          );
    return {
      width: bounds.width - Math.abs(lag) * 0.35,
      height: bounds.height + lag,
      borderRadius: 28 + Math.abs(lag) * 0.25,
      transform: [{ translateX: Math.abs(lag) * 0.175 }],
    };
  });
  const content = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          reduced || !slideFromBottom
            ? 0
            : -Math.abs(
                Math.max(
                  -24,
                  Math.min(40, (outlineOffset.get() - offset.get()) * 0.12),
                ),
              ) * 0.175,
      },
    ],
    opacity:
      reduced || !slideFromBottom
        ? 1
        : interpolate(
            offset.get(),
            [0, distance * 0.65, distance],
            [1, 1, 0],
            "clamp",
          ),
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
      {slideFromBottom ? (
        <Animated.View style={[{ flex: 1 }, rise]}>
          <Animated.View
            style={[
              {
                position: "absolute",
                left: 0,
                top: 0,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.line,
                boxShadow: "0 8px 36px #00000025",
                overflow: "hidden",
              },
              silhouette,
            ]}
          >
            {/* Only the clipping bounds deform. The page is positioned at its
                final dimensions, so its opaque background cannot escape the
                liquid outline and its labels never scale or rewrap. */}
            <Animated.View
              pointerEvents={open ? "auto" : "none"}
              accessibilityElementsHidden={!open}
              importantForAccessibility={open ? "auto" : "no-hide-descendants"}
              style={[
                {
                  position: "absolute",
                  width: bounds.width,
                  height: bounds.height,
                },
                content,
              ]}
            >
              {children}
            </Animated.View>
          </Animated.View>
        </Animated.View>
      ) : (
        <Animated.View
          pointerEvents={open ? "auto" : "none"}
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? "auto" : "no-hide-descendants"}
          style={[
            {
              flexGrow: 1,
              flexShrink: 1,
              borderRadius: 28,
              overflow: "hidden",
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.line,
              boxShadow: "0 8px 36px #00000025",
            },
            rise,
          ]}
        >
          {children}
        </Animated.View>
      )}
    </View>
  );
}
