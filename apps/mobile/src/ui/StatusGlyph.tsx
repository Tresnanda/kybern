// Thread status as a glyph: breathing blue dot while working, amber dot when
// waiting on you, red dot when failed, nothing when idle.

import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import type { ThreadStatus } from "@/protocol";
import { useTheme, type Theme } from "./theme";

export function statusColor(status: ThreadStatus, th: Theme): string | null {
  switch (status) {
    case "running":
      return th.running;
    case "awaiting-approval":
      return th.waiting;
    case "failed":
      return th.failed;
    default:
      return null;
  }
}

export function statusLabel(status: ThreadStatus): string | null {
  switch (status) {
    case "running":
      return "Working";
    case "awaiting-approval":
      return "Needs you";
    case "failed":
      return "Failed";
    case "archived":
      return "Archived";
    default:
      return null;
  }
}

export function StatusGlyph({ status, size = 8 }: { status: ThreadStatus; size?: number }) {
  const th = useTheme();
  const color = statusColor(status, th);
  const reduced = useReducedMotion();
  const breathe = useSharedValue(1);

  useEffect(() => {
    if (status === "running" && !reduced) {
      breathe.set(withRepeat(withTiming(0.35, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true));
    } else {
      breathe.set(withTiming(1, { duration: 150 }));
    }
  }, [status, reduced, breathe]);

  const style = useAnimatedStyle(() => ({ opacity: breathe.get() }));

  if (!color) return <View style={{ width: size, height: size }} />;
  return (
    <Animated.View
      accessibilityLabel={statusLabel(status) ?? undefined}
      style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}

const styles = StyleSheet.create({ dot: {} });
