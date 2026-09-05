// Page scaffolding: an ambient canvas the glass can refract, plus text helpers
// that carry the type scale so screens never set raw font sizes.

import React, { useRef } from "react";
import { StyleSheet, Text, View, type StyleProp, type TextProps, type TextStyle, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { BlurTargetContext } from "./Glass";
import { space, type as t, useTheme } from "./theme";

export function Screen({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const th = useTheme();
  const target = useRef<View>(null);
  return (
    <View ref={target} collapsable={false} style={[styles.screen, { backgroundColor: th.canvas }, style]}>
      <LinearGradient
        pointerEvents="none"
        colors={[th.canvas, th.canvasDeep]}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <BlurTargetContext.Provider value={target}>{children}</BlurTargetContext.Provider>
    </View>
  );
}

type Tone = "primary" | "secondary" | "tertiary";
type Variant = keyof typeof t;

interface TypoProps extends TextProps {
  variant?: Variant;
  tone?: Tone;
  color?: string;
  style?: StyleProp<TextStyle>;
}

export function Txt({ variant = "body", tone = "primary", color, style, ...rest }: TypoProps) {
  const th = useTheme();
  const fallback = tone === "primary" ? th.text : tone === "secondary" ? th.textSecondary : th.textTertiary;
  return <Text {...rest} style={[t[variant], { color: color ?? fallback }, style]} />;
}

/** Orients and offers one action. */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <View style={styles.empty}>
      <Txt variant="title3" style={{ textAlign: "center" }}>
        {title}
      </Txt>
      {hint ? (
        <Txt variant="subhead" tone="secondary" style={{ textAlign: "center", maxWidth: 300 }}>
          {hint}
        </Txt>
      ) : null}
      {action ? <View style={{ marginTop: space.sm }}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl, gap: space.sm },
});
