import { SymbolView } from "expo-symbols";
import { useState, type PropsWithChildren, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  cubicBezier,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type as typography, useTheme } from "./theme";

export function T({
  variant = "body",
  tone = "ink",
  style,
  ...props
}: TextProps & {
  variant?: keyof typeof typography;
  tone?:
    | "ink"
    | "secondary"
    | "muted"
    | "accent"
    | "positive"
    | "negative"
    | "inverse"
    | "warning";
}) {
  const { colors } = useTheme();
  return (
    <Text
      {...props}
      style={[typography[variant], { color: colors[tone] }, style]}
    />
  );
}
export type { IconName } from "./icons";
import { androidIcons, type IconName } from "./icons";
export function Icon({
  name,
  size = 21,
  color,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  const { colors } = useTheme();
  return (
    <SymbolView
      name={{ ios: name, android: androidIcons[name], web: androidIcons[name] }}
      size={size}
      tintColor={color ?? colors.ink}
      weight="regular"
      style={{ width: size, height: size }}
    />
  );
}
export function Tap({
  children,
  onPress,
  onLongPress,
  label,
  style,
  disabled,
  selected,
  static: isStatic = false,
}: PropsWithChildren<{
  onPress?: () => void;
  onLongPress?: () => void;
  label: string;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  selected?: boolean;
  static?: boolean;
}>) {
  const [pressed, setPressed] = useState(false);
  const reduced = useReducedMotion();
  return (
    <Pressable
      style={{ flex: StyleSheet.flatten(style)?.flex }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      pressRetentionOffset={16}
    >
      <Animated.View
        style={[
          {
            minHeight: 44,
            minWidth: 44,
            justifyContent: "center",
            opacity: disabled ? 0.38 : pressed ? 0.72 : 1,
            transform: [{ scale: pressed && !reduced && !isStatic ? 0.96 : 1 }],
            transitionProperty: ["transform", "opacity"],
            transitionDuration: 120,
            transitionTimingFunction: cubicBezier(0.23, 1, 0.32, 1),
          },
          style,
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}
export function IconButton({
  name,
  label,
  onPress,
  filled = false,
  disabled,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  filled?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Tap
      label={label}
      onPress={onPress}
      disabled={disabled}
      style={{
        width: 44,
        height: 44,
        alignItems: "center",
        borderRadius: 22,
        backgroundColor: filled ? colors.ink : undefined,
      }}
    >
      <Icon name={name} color={filled ? colors.inverse : colors.ink} />
    </Tap>
  );
}
export function Button({
  children,
  onPress,
  busy,
  disabled,
  secondary,
  danger,
  icon,
}: PropsWithChildren<{
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
  icon?: IconName;
}>) {
  const { colors } = useTheme();
  return (
    <Tap
      label={typeof children === "string" ? children : "Continue"}
      onPress={onPress}
      disabled={disabled || busy}
      style={{
        minHeight: 52,
        borderRadius: 18,
        paddingHorizontal: 20,
        backgroundColor: secondary
          ? colors.raised
          : danger
            ? colors.negative
            : colors.ink,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      {busy ? (
        <ActivityIndicator color={secondary ? colors.ink : colors.inverse} />
      ) : (
        icon && (
          <Icon
            name={icon}
            color={secondary ? colors.ink : colors.inverse}
            size={18}
          />
        )
      )}
      <T variant="label" tone={secondary ? "ink" : "inverse"}>
        {children}
      </T>
    </Tap>
  );
}
export function Field({
  label,
  error,
  ...props
}: TextInputProps & { label: string; error?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <T variant="label">{label}</T>
      <TextInput
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        style={[
          typography.body,
          {
            color: colors.ink,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: error ? colors.negative : colors.line,
            borderRadius: 16,
            padding: 15,
            minHeight: 52,
          },
          props.style,
        ]}
      />
      {error && (
        <T variant="caption" tone="negative">
          {error}
        </T>
      )}
    </View>
  );
}
export function Row({
  title,
  detail,
  detailLines,
  icon,
  onPress,
  trailing,
  danger,
}: {
  title: string;
  detail?: string;
  detailLines?: number;
  icon?: IconName;
  onPress?: () => void;
  trailing?: ReactNode;
  danger?: boolean;
}) {
  const { colors } = useTheme();
  const inner = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 15,
      }}
    >
      {icon && (
        <Icon name={icon} color={danger ? colors.negative : colors.secondary} />
      )}
      <View style={{ flex: 1, gap: 3 }}>
        <T variant="label" tone={danger ? "negative" : "ink"}>
          {title}
        </T>
        {detail && (
          <T variant="caption" tone="secondary" numberOfLines={detailLines}>
            {detail}
          </T>
        )}
      </View>
      {trailing ??
        (onPress && (
          <Icon name="chevron.right" size={13} color={colors.muted} />
        ))}
    </View>
  );
  return onPress ? (
    <Tap onPress={onPress} label={title}>
      {inner}
    </Tap>
  ) : (
    inner
  );
}
export function Group({
  title,
  children,
}: PropsWithChildren<{ title?: string }>) {
  return (
    <View style={{ gap: 6, marginBottom: 26 }}>
      {title && (
        <T variant="caption" tone="secondary" style={{ marginBottom: 6 }}>
          {title}
        </T>
      )}
      {children}
    </View>
  );
}
export function Page({
  children,
  scroll = true,
}: PropsWithChildren<{ scroll?: boolean }>) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const content = {
    padding: 24,
    paddingBottom: insets.bottom + 28,
    width: "100%" as const,
    maxWidth: 760,
    alignSelf: "center" as const,
  };
  return scroll ? (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1, backgroundColor: colors.background }, content]}>
      {children}
    </View>
  );
}
export function Empty({
  icon = "sparkle",
  title,
  detail,
  action,
}: {
  icon?: IconName;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ paddingVertical: 42, gap: 16, alignItems: "flex-start" }}>
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 18,
          backgroundColor: colors.raised,
          justifyContent: "center",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <Icon name={icon} size={25} />
      </View>
      <T variant="title">{title}</T>
      <T tone="secondary" style={{ maxWidth: 340 }}>
        {detail}
      </T>
      {action && <View style={{ marginTop: 10 }}>{action}</View>}
    </View>
  );
}
export function ErrorBanner({
  error,
  onRetry,
}: {
  error?: string | null;
  onRetry?: () => void;
}) {
  const { colors } = useTheme();
  if (!error) return null;
  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(120)}
      accessibilityLiveRegion="polite"
      style={{
        padding: 16,
        marginVertical: 8,
        borderRadius: 16,
        backgroundColor: colors.warningSoft,
        gap: 6,
      }}
    >
      <T variant="label" tone="warning">
        {error}
      </T>
      {onRetry && (
        <Tap label="Try again" onPress={onRetry}>
          <T variant="label">Try again</T>
        </Tap>
      )}
    </Animated.View>
  );
}
export const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 10 },
  spread: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  column: { gap: 16 },
});
