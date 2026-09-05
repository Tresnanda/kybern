// Liquid Glass surface. Real UIGlassEffect on iOS 26+, a blurred and tinted
// material everywhere else (older iOS, Android) so both platforms read the same.

import React, { createContext, useContext, type RefObject } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { GlassContainer, GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { radius as r, useTheme } from "./theme";

export const liquidGlass = Platform.OS === "ios" && isLiquidGlassAvailable();

/** The view the fallback blur samples from; `Screen` provides it. */
export const BlurTargetContext = createContext<RefObject<View | null> | null>(null);

interface GlassProps extends ViewProps {
  /** `clear` lets more content through; use it over media, `regular` over text. */
  variant?: "regular" | "clear";
  /** Reacts to touch with the system's press scaling and shimmer (iOS 26). */
  interactive?: boolean;
  tint?: string;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

export function Glass({ variant = "regular", interactive, tint, radius = r.lg, style, children, ...rest }: GlassProps) {
  const th = useTheme();
  const blurTarget = useContext(BlurTargetContext);
  if (liquidGlass) {
    return (
      <GlassView
        glassEffectStyle={variant}
        isInteractive={interactive}
        tintColor={tint}
        style={[{ borderRadius: radius, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, borderColor: th.glassBorder }, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[{ borderRadius: radius, borderCurve: "continuous", overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: th.glassBorder }, style]} {...rest}>
      <BlurView
        intensity={variant === "clear" ? 30 : 55}
        tint={th.dark ? "dark" : "light"}
        blurMethod={blurTarget ? "dimezisBlurView" : "none"}
        blurTarget={blurTarget ?? undefined}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint ?? th.glassFill }]} />
      {children}
    </View>
  );
}

/** Groups glass siblings so they merge when they get close (iOS 26); plain view elsewhere. */
export function GlassGroup({ spacing = 12, style, children }: { spacing?: number; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  if (liquidGlass) {
    return (
      <GlassContainer spacing={spacing} style={style}>
        {children}
      </GlassContainer>
    );
  }
  return <View style={style}>{children}</View>;
}
