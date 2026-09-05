// "Thinking" line that breathes while the agent has nothing to show yet.

import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { Txt } from "./Screen";
import { StatusGlyph } from "./StatusGlyph";
import { space } from "./theme";

export function Thinking({ label = "Thinking" }: { label?: string }) {
  const reduced = useReducedMotion();
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (reduced) return;
    pulse.set(withRepeat(withTiming(0.4, { duration: 800, easing: Easing.inOut(Easing.quad) }), -1, true));
  }, [reduced, pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.get() }));

  return (
    <View style={styles.wrap} accessibilityLabel={`${label}…`}>
      <StatusGlyph status="running" size={8} />
      <Animated.View style={style}>
        <Txt variant="subhead" tone="secondary">
          {label}…
        </Txt>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { flexDirection: "row", alignItems: "center", gap: space.sm } });
