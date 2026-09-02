// Shared page primitives: a canvas-colored container and text helpers.

import React from "react";
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { space, type as t, useTheme } from "./theme";

export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const th = useTheme();
  return <View style={[styles.screen, { backgroundColor: th.canvas }, style]}>{children}</View>;
}

export function Caption({ children, style, color }: { children: React.ReactNode; style?: TextStyle; color?: string }) {
  const th = useTheme();
  return <Text style={[t.caption, { color: color ?? th.textSecondary }, style]}>{children}</Text>;
}

export function Body({ children, style, color }: { children: React.ReactNode; style?: TextStyle; color?: string }) {
  const th = useTheme();
  return <Text style={[t.body, { color: color ?? th.text }, style]}>{children}</Text>;
}

/** Orients and offers one action. */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  const th = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[t.heading, { color: th.text, textAlign: "center" }]}>{title}</Text>
      {hint ? <Text style={[t.body, { color: th.textSecondary, textAlign: "center" }]}>{hint}</Text> : null}
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.md },
});
