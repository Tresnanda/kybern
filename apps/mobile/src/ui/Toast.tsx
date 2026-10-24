// Toast: a short notice above the home indicator, with at most one action
// ("Note deleted · Undo", "ADE-14 started · Open"). Replaces UndoBar and the
// task toast. Use `showToast()` from anywhere; screens with their own toast
// state render `<Toast>` directly.
import { useEffect, useSyncExternalStore } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import {
  COMMIT,
  DURATION,
  EASE_OUT,
  RECOIL,
  project,
  rubberBand,
  withMomentum,
} from "../components/liquid/motion";
import { Icon, T, Tap, type IconName } from "./primitives";
import { radius, space, useTheme } from "./theme";

export type ToastAction = { title: string; icon?: IconName; onPress: () => void };

/**
 * The toast surface. Swipe it down or sideways to dismiss: a flick is enough
 * (the release is projected), anything short recoils home with its velocity.
 */
export function Toast({
  text,
  action,
  onDismiss,
  bottom = 0,
}: {
  text: string;
  action?: ToastAction;
  onDismiss: () => void;
  /** Extra space above the safe area (a bottom bar's height). */
  bottom?: number;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .activeOffsetY([-12, 12])
    .onUpdate((e) => {
      x.set(e.translationX);
      // Down is free; up resists.
      y.set(e.translationY > 0 ? e.translationY : rubberBand(e.translationY, 120));
    })
    .onEnd((e) => {
      const sideways = Math.abs(project(e.translationX, e.velocityX)) > 140;
      const down = project(e.translationY, e.velocityY) > 60;
      if (sideways || down) {
        x.set(withSpring(sideways ? Math.sign(e.translationX || e.velocityX) * 600 : x.get(), withMomentum(COMMIT, e.velocityX)));
        y.set(withSpring(down ? 200 : y.get(), withMomentum(COMMIT, e.velocityY)));
        scheduleOnRN(onDismiss);
      } else {
        x.set(withSpring(0, withMomentum(RECOIL, e.velocityX)));
        y.set(withSpring(0, withMomentum(RECOIL, e.velocityY)));
      }
    });
  const drag = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }],
  }));
  return (
    <Animated.View
      pointerEvents="box-none"
      entering={
        reduced
          ? FadeIn.duration(DURATION.enter)
          : FadeInDown.duration(DURATION.enter).easing(EASE_OUT)
      }
      exiting={
        reduced ? FadeOut.duration(DURATION.exit) : FadeOutDown.duration(DURATION.exit)
      }
      style={{
        position: "absolute",
        start: space.lg,
        end: space.lg,
        bottom: insets.bottom + space.md + bottom,
        alignItems: "center",
      }}
    >
      <GestureDetector gesture={pan}>
        <Animated.View
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={[
            {
              width: "100%",
              maxWidth: 520,
              minHeight: 52,
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingStart: space.lg,
              paddingEnd: action ? 6 : space.lg,
              paddingVertical: 6,
              borderRadius: radius.lg,
              backgroundColor: colors.raised,
              borderWidth: 1,
              borderColor: colors.line,
              boxShadow: "0 8px 24px #0000002E",
            },
            drag,
          ]}
        >
          <T variant="subhead" numberOfLines={2} style={{ flex: 1, fontVariant: ["tabular-nums"] }}>
            {text}
          </T>
          {action && (
            <Tap
              label={action.title}
              feedback="highlight"
              onPress={action.onPress}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                minHeight: 40,
                paddingHorizontal: space.md,
                borderRadius: radius.md,
              }}
            >
              {action.icon && <Icon name={action.icon} size={15} color={colors.accent} />}
              <T variant="label" tone="accent" style={{ fontWeight: "600" }}>
                {action.title}
              </T>
            </Tap>
          )}
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

type Notice = { id: number; text: string; action?: ToastAction; ms: number };
let current: Notice | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** App-wide toast: "Thread archived · Undo", "Branch name copied". Replaces the visible one. */
export function showToast(text: string, action?: ToastAction, ms = 4000) {
  clearTimeout(timer);
  current = { id: ++seq, text, action, ms };
  emit();
  timer = setTimeout(dismissToast, ms);
}
export function dismissToast() {
  clearTimeout(timer);
  timer = undefined;
  if (!current) return;
  current = null;
  emit();
}

/** Mount once at the root. */
export function ToastHost() {
  const notice = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  useEffect(() => () => clearTimeout(timer), []);
  if (!notice) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }}>
      <Toast
        key={notice.id}
        text={notice.text}
        action={
          notice.action && {
            ...notice.action,
            onPress: () => {
              dismissToast();
              notice.action!.onPress();
            },
          }
        }
        onDismiss={dismissToast}
      />
    </View>
  );
}
