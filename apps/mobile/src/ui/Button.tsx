import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { radius, space, type as t, useTheme } from "./theme";

type Variant = "primary" | "secondary" | "destructive";

interface Props {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}

export function Button({ title, onPress, variant = "secondary", disabled, busy, style }: Props) {
  const th = useTheme();
  const bg = variant === "primary" ? th.accent : th.surfaceRaised;
  const fg = variant === "primary" ? th.onAccent : variant === "destructive" ? th.failed : th.text;
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: bg, opacity: inactive ? 0.5 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.label, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { ...t.body, fontWeight: "600" },
});
