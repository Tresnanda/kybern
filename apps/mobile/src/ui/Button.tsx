// Buttons: `ink` is the one primary action on a surface, `glass` floats over
// content, `quiet` sits inline. Labels are verb-first.

import React from "react";
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { Txt } from "./Screen";
import { Tap } from "./Tap";
import { radius, space, useTheme } from "./theme";

type Variant = "ink" | "glass" | "quiet";

interface Props {
  title: string;
  onPress: () => void;
  variant?: Variant;
  icon?: IconName;
  destructive?: boolean;
  disabled?: boolean;
  busy?: boolean;
  size?: "regular" | "large";
  style?: StyleProp<ViewStyle>;
  haptic?: "light" | "medium" | "success" | "error" | false;
}

export function Button({ title, onPress, variant = "glass", icon, destructive, disabled, busy, size = "regular", style, haptic = "light" }: Props) {
  const th = useTheme();
  const inactive = disabled || busy;
  const fg = variant === "ink" ? th.onInk : destructive ? th.failed : th.text;
  const height = size === "large" ? 52 : 44;
  const content = (
    <View style={[styles.content, { height }]}>
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={17} color={fg} weight="semibold" /> : null}
          <Txt variant={size === "large" ? "headline" : "subhead"} color={fg} style={{ fontWeight: "600" }} numberOfLines={1}>
            {title}
          </Txt>
        </>
      )}
    </View>
  );
  return (
    <Tap
      onPress={onPress}
      disabled={inactive}
      haptic={haptic}
      accessibilityState={{ disabled: inactive, busy }}
      style={[styles.base, style]}
    >
      {variant === "glass" ? (
        <Glass interactive radius={radius.pill}>
          {content}
        </Glass>
      ) : (
        <View style={[styles.fill, { backgroundColor: variant === "ink" ? th.ink : "transparent" }]}>{content}</View>
      )}
    </Tap>
  );
}

/** Round icon-only button; the send circle, the close X. */
export function IconButton({
  icon,
  onPress,
  size = 44,
  variant = "glass",
  disabled,
  accessibilityLabel,
  style,
  haptic = "light",
  color,
}: {
  icon: IconName;
  onPress: () => void;
  size?: number;
  variant?: Variant;
  disabled?: boolean;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  haptic?: "light" | "medium" | false;
  color?: string;
}) {
  const th = useTheme();
  const fg = color ?? (variant === "ink" ? th.onInk : th.text);
  const glyph = <Icon name={icon} size={Math.round(size * 0.42)} color={fg} weight="semibold" />;
  return (
    <Tap onPress={onPress} disabled={disabled} haptic={haptic} accessibilityLabel={accessibilityLabel} hitSlop={6} style={style}>
      {variant === "glass" ? (
        <Glass interactive radius={size / 2} style={[styles.round, { width: size, height: size }]}>
          {glyph}
        </Glass>
      ) : (
        <View style={[styles.round, { width: size, height: size, borderRadius: size / 2, backgroundColor: variant === "ink" ? th.ink : "transparent" }]}>{glyph}</View>
      )}
    </Tap>
  );
}

const styles = StyleSheet.create({
  base: { alignSelf: "stretch" },
  fill: { borderRadius: radius.pill },
  content: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.xl },
  round: { alignItems: "center", justifyContent: "center" },
});
