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
  heightFraction = 1,
  offset: externalOffset,
  releaseVelocity,
  touchBias,
}: PropsWithChildren<{
  open: boolean;
  onClosed: () => void;
  style?: StyleProp<ViewStyle>;
  slideFromBottom?: boolean;
  bottomInset?: number;
  heightFraction?: number;
  offset?: SharedValue<number>;
  releaseVelocity?: SharedValue<number>;
  touchBias?: SharedValue<number>;
}>) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const initialized = useRef(false);
  const ready = useSharedValue(false);
  const visualHeight = useSharedValue(0);
  const localOffset = useSharedValue(0);
  const offset = externalOffset ?? localOffset;
  const fade = useSharedValue(0);
  const targetHeight = bounds.height * heightFraction;
  const distance = targetHeight + bottomInset + 32;
  const outlineOffset = useDerivedValue(() =>
    withSpring(offset.get(), SHEET_OUTLINE),
  );
  useEffect(() => {
    if (!bounds.height) return;
    // Keep the measured parent at full height. Detent changes only move this
    // silhouette, so no native layout frame can briefly move its bottom edge.
    visualHeight.set(
      visualHeight.get() === 0 || reduced
        ? targetHeight
        : withSpring(targetHeight, SHEET),
    );
  }, [bounds.height, targetHeight, reduced, visualHeight]);
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
    transform: [
      {
        translateY: !slideFromBottom
          ? 0
          : (reduced ? 0 : offset.get()) + bounds.height - visualHeight.get(),
      },
    ],
  }));
  const deformation = useDerivedValue(() => {
    const lag =
      reduced || !slideFromBottom
        ? 0
        : Math.max(
            -28,
            Math.min(44, (outlineOffset.get() - offset.get()) * 0.2),
          );
    const pull = Math.abs(lag);
    const bias = touchBias?.get() ?? 0;
    return { lag, pull, inset: pull * 0.3, bias };
  });
  const silhouette = useAnimatedStyle(() => {
    // The touched side leads; the far corner stretches and catches up. Only
    // the clipping surface bends, while the content keeps its native scale.
    const { lag, pull, inset, bias } = deformation.get();
    return {
      width: bounds.width - inset * 2,
      height: visualHeight.get() + lag,
      borderTopLeftRadius: 28 + pull * (0.45 + bias * 0.25),
      borderTopRightRadius: 28 + pull * (0.45 - bias * 0.25),
      borderBottomLeftRadius: 28 + pull * (0.2 - bias * 0.12),
      borderBottomRightRadius: 28 + pull * (0.2 + bias * 0.12),
      transform: [{ translateX: inset }],
    };
  });
  const content = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: -deformation.get().inset,
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
      pointerEvents="box-none"
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
        <Animated.View pointerEvents="box-none" style={[{ flex: 1 }, rise]}>
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
                  height: targetHeight,
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
