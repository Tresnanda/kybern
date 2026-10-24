// Base primitives. Rules and examples: apps/mobile/docs/design-system.md.
import { Busy } from "./Busy";
import { SymbolView } from "expo-symbols";
import { useState, type PropsWithChildren, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CSS_EASE_OUT, DURATION } from "../components/liquid/motion";
import {
  CONTENT_MAX_WIDTH,
  MONO,
  gutter,
  maxScale,
  radius,
  space,
  type ColorToken,
  type TypeRole,
  type as typography,
  useTheme,
} from "./theme";

export type Tone = Extract<
  ColorToken,
  | "ink"
  | "secondary"
  | "muted"
  | "accent"
  | "positive"
  | "negative"
  | "inverse"
  | "warning"
  | "onProminent"
  | "onAccent"
>;

/** Text in one of the type roles. Scales with Dynamic Type up to the role's ceiling. */
export function T({
  variant = "body",
  tone = "ink",
  style,
  ...props
}: TextProps & { variant?: TypeRole; tone?: Tone }) {
  const { colors } = useTheme();
  return (
    <Text
      maxFontSizeMultiplier={maxScale(variant)}
      {...props}
      style={[typography[variant], { color: colors[tone] }, style]}
    />
  );
}
export type { IconName } from "./icons";
import { androidIcons, type IconName } from "./icons";
/** Bar and button icons: 22 pt on iOS (SF `.body`), 24 dp on Android. Rows use 20. */
export const ICON_SIZE = Platform.OS === "ios" ? 22 : 24;
export function Icon({
  name,
  size = ICON_SIZE,
  color,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  // Android SymbolView renders scalable Text inside fixed icon bounds.
  // Keep the glyph at its requested size while surrounding labels scale.
  const symbolSize = Platform.OS === "android" ? size / fontScale : size;
  return (
    <SymbolView
      name={{ ios: name, android: androidIcons[name], web: androidIcons[name] }}
      size={symbolSize}
      tintColor={color ?? colors.ink}
      weight="regular"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * The base pressable: 44 pt minimum target, press feedback on press-in.
 * `feedback`: "scale" for buttons (0.96, no fade), "highlight" for rows (a
 * `raised` background, 80 ms in / 200 ms out), "none" when the child draws its
 * own. `static` is the older name for "highlight". Column layouts center their
 * content; rows (`flexDirection: "row"`) keep their own alignment.
 */
export function Tap({
  children,
  onPress,
  onLongPress,
  label,
  hint,
  style,
  disabled,
  selected,
  expanded,
  feedback,
  hitSlop,
  static: isStatic = false,
}: PropsWithChildren<{
  onPress?: (event: GestureResponderEvent) => void;
  onLongPress?: (event: GestureResponderEvent) => void;
  label: string;
  hint?: string;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
  feedback?: "scale" | "highlight" | "none";
  /** Grow the target past a small visual (keep the visual small, the target 44). */
  hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number };
  /** @deprecated Use `feedback="highlight"`. */
  static?: boolean;
}>) {
  const { colors } = useTheme();
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const reduced = useReducedMotion();
  const flat = StyleSheet.flatten(style) ?? {};
  const mode = feedback ?? (isStatic ? "highlight" : "scale");
  const active = pressed || hovered;
  const highlight = mode === "highlight" && active && !disabled;
  return (
    <Pressable
      style={{ flex: flat.flex, alignSelf: flat.alignSelf }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled, selected, expanded }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      // Trackpad/pointer feedback on iPad; touch devices never fire these.
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={hitSlop ?? (Platform.OS === "android" ? 2 : undefined)}
      pressRetentionOffset={16}
    >
      <Animated.View
        style={[
          {
            minHeight: 44,
            minWidth: 44,
            justifyContent: flat.flexDirection?.startsWith("row")
              ? undefined
              : "center",
          },
          style,
          {
            opacity: disabled
              ? 0.38
              : mode === "scale" && hovered && !pressed
                ? 0.9
                : 1,
            transform: [
              {
                scale: mode === "scale" && pressed && !reduced ? 0.96 : 1,
              },
            ],
            ...(mode === "highlight"
              ? {
                  backgroundColor: highlight
                    ? colors.raised
                    : (flat.backgroundColor ?? "transparent"),
                }
              : null),
            transitionProperty:
              mode === "highlight"
                ? ["backgroundColor"]
                : ["transform", "opacity"],
            transitionDuration:
              mode === "highlight"
                ? highlight
                  ? DURATION.pressIn
                  : DURATION.pressOut
                : DURATION.press,
            transitionTimingFunction: CSS_EASE_OUT,
          },
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}

/** A 44 pt icon-only button. `filled` is the composer's send disc. */
export function IconButton({
  name,
  label,
  onPress,
  filled = false,
  disabled,
  color,
  size,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  filled?: boolean;
  disabled?: boolean;
  color?: string;
  size?: number;
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
        borderRadius: radius.full,
        backgroundColor: filled ? colors.ink : undefined,
      }}
    >
      <Icon
        name={name}
        size={size}
        color={filled ? colors.inverse : (color ?? colors.ink)}
      />
    </Tap>
  );
}

/**
 * Button roles (design-system.md §Buttons):
 * - `prominent`: the one commit per screen (Connect, Start, Save).
 * - `tinted` (default): secondary commits; accent text on `accentSoft`.
 * - `plain`: text only, for header actions and inline "New" / "See all".
 * - `destructive`: red text, no fill. A red fill exists only in confirmations.
 * `size` "large" is 48 pt (forms, sheets, bottom bars), "medium" 36 pt, "small"
 * 32 pt (inline actions under a message; its target grows to 44 pt).
 */
export type ButtonRole = "prominent" | "tinted" | "plain" | "destructive";
export function Button({
  children,
  onPress,
  busy,
  disabled,
  role = "tinted",
  size = "large",
  icon,
  label,
}: PropsWithChildren<{
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  role?: ButtonRole;
  size?: "large" | "medium" | "small";
  icon?: IconName;
  /** Accessible name when the visible text alone says too little. */
  label?: string;
}>) {
  const { colors } = useTheme();
  const fill =
    role === "prominent"
      ? colors.prominent
      : role === "tinted"
        ? colors.accentSoft
        : undefined;
  const ink =
    role === "prominent"
      ? colors.onProminent
      : role === "destructive"
        ? colors.negative
        : colors.accent;
  const tone: Tone =
    role === "prominent"
      ? "onProminent"
      : role === "destructive"
        ? "negative"
        : "accent";
  const large = size === "large";
  const filled = role === "prominent" || role === "tinted";
  return (
    <Tap
      label={label ?? (typeof children === "string" ? children : "Continue")}
      onPress={onPress}
      disabled={disabled || busy}
      hitSlop={size === "small" ? { top: 6, bottom: 6 } : undefined}
      style={{
        minHeight: large ? 48 : size === "small" ? 32 : 36,
        // 48 pt full-width buttons nest in `lg` cards at 6 pt; smaller ones are capsules.
        borderRadius: large ? radius.md : radius.full,
        paddingHorizontal: filled ? (large ? 20 : size === "small" ? 12 : 14) : 0,
        backgroundColor: fill,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
      }}
    >
      {busy ? (
        <Busy color={ink} />
      ) : (
        icon && <Icon name={icon} color={ink} size={large ? 18 : 16} />
      )}
      <T
        variant="label"
        tone={tone}
        numberOfLines={1}
        style={role === "destructive" ? { fontWeight: "600" } : undefined}
      >
        {children}
      </T>
    </Tap>
  );
}

/**
 * A labelled text input. Tracking is always 0: a letter-spaced input once
 * leaked its kern into recycled fields' placeholders. `variant="code"` is the
 * pairing code entry: monospaced tabular figures at 28 pt.
 */
export function Field({
  label,
  error,
  hideLabel = false,
  variant = "default",
  ...props
}: TextInputProps & {
  label: string;
  error?: string;
  hideLabel?: boolean;
  variant?: "default" | "code";
}) {
  const { colors } = useTheme();
  const code = variant === "code";
  return (
    <View style={{ gap: space.sm }}>
      {!hideLabel && <T variant="label">{label}</T>}
      <TextInput
        underlineColorAndroid="transparent"
        maxFontSizeMultiplier={maxScale("body")}
        {...(code
          ? {
              keyboardType: "number-pad" as const,
              textContentType: "oneTimeCode" as const,
              autoComplete: "one-time-code" as const,
            }
          : null)}
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        style={[
          typography.body,
          code && {
            fontFamily: MONO,
            fontSize: 28,
            lineHeight: 34,
            fontVariant: ["tabular-nums"],
          },
          {
            color: colors.ink,
            backgroundColor: colors.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: error ? colors.negative : colors.line,
            borderRadius: radius.md,
            paddingHorizontal: 14,
            paddingVertical: 12,
            minHeight: 48,
          },
          props.style,
          { letterSpacing: 0 },
        ]}
      />
      {error && (
        <T variant="footnote" tone="negative">
          {error}
        </T>
      )}
    </View>
  );
}

/**
 * @deprecated Use `ListRow` inside an `InsetGroup` (ui/List.tsx). Kept until the
 * screen lanes have moved their call sites.
 */
export function Row({
  title,
  label,
  detail,
  detailLines,
  icon,
  onPress,
  trailing,
  danger,
}: {
  title: string;
  /** Accessible name when the title alone says too little. */
  label?: string;
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
        paddingVertical: 12,
      }}
    >
      {icon && (
        <Icon
          name={icon}
          size={20}
          color={danger ? colors.negative : colors.secondary}
        />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="label" tone={danger ? "negative" : "ink"}>
          {title}
        </T>
        {detail && (
          <T variant="footnote" tone="secondary" numberOfLines={detailLines}>
            {detail}
          </T>
        )}
      </View>
      {trailing ??
        (onPress && (
          <Icon name="chevron.right" size={12} color={colors.muted} />
        ))}
    </View>
  );
  return onPress ? (
    <Tap onPress={onPress} label={label ?? title} feedback="highlight">
      {inner}
    </Tap>
  ) : (
    inner
  );
}
/** @deprecated Use `SectionHeader` + `InsetGroup` (ui/List.tsx). */
export function Group({
  title,
  children,
}: PropsWithChildren<{ title?: string }>) {
  return (
    <View style={{ gap: 6, marginBottom: space.xl }}>
      {title && (
        <T
          variant="sectionHeader"
          tone="secondary"
          accessibilityRole="header"
          style={{ marginBottom: 6 }}
        >
          {title}
        </T>
      )}
      {children}
    </View>
  );
}

/**
 * A scrolling page in the content column with the standard gutter. `grouped`
 * uses the grouped background behind `InsetGroup`s (settings, task page).
 */
export function Page({
  children,
  scroll = true,
  grouped = false,
}: PropsWithChildren<{ scroll?: boolean; grouped?: boolean }>) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const background = grouped ? colors.grouped : colors.background;
  const content = {
    paddingHorizontal: gutter(width),
    paddingTop: space.lg,
    paddingBottom: insets.bottom + space["2xl"],
    width: "100%" as const,
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: "center" as const,
  };
  return scroll ? (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: background }}
      contentContainerStyle={content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1, backgroundColor: background }, content]}>
      {children}
    </View>
  );
}

/**
 * Empty states. `screen` (default): nothing on the screen at all; centred icon,
 * headline, one line of help and at most one tinted action, placed at 38 % of the
 * free height. `inline`: an empty group; one quiet footnote line.
 */
export function Empty({
  icon = "sparkle",
  title,
  detail,
  action,
  variant = "screen",
}: {
  icon?: IconName;
  title: string;
  detail?: string;
  action?: ReactNode;
  variant?: "screen" | "inline";
}) {
  const { colors } = useTheme();
  if (variant === "inline")
    return action ? (
      // A filtered group with nothing in it: the line, then one plain action at the end.
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          minHeight: 44,
          paddingHorizontal: space.lg,
        }}
      >
        <T variant="footnote" tone="muted" style={{ flex: 1 }}>
          {title}
        </T>
        {action}
      </View>
    ) : (
      <View style={{ paddingVertical: space.sm, paddingHorizontal: space.lg }}>
        <T variant="footnote" tone="muted">
          {title}
        </T>
      </View>
    );
  return (
    <View style={{ flexGrow: 1, minHeight: 280 }}>
      <View style={{ flexGrow: 38 }} />
      <View
        style={{
          alignItems: "center",
          gap: space.sm,
          paddingVertical: space["3xl"],
          paddingHorizontal: space.xl,
        }}
      >
        <Icon name={icon} size={34} color={colors.muted} />
        <T
          variant="headline"
          accessibilityRole="header"
          style={{ textAlign: "center", marginTop: space.xs }}
        >
          {title}
        </T>
        {detail ? (
          <T
            variant="subhead"
            tone="secondary"
            style={{ textAlign: "center", maxWidth: 300 }}
          >
            {detail}
          </T>
        ) : null}
        {action && <View style={{ marginTop: space.md }}>{action}</View>}
      </View>
      <View style={{ flexGrow: 62 }} />
    </View>
  );
}

/** A failure that blocks the screen's purpose. Says what to do next; offers a retry. */
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
      entering={FadeIn.duration(DURATION.enter)}
      exiting={FadeOut.duration(DURATION.exit)}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingVertical: space.md,
        paddingHorizontal: 14,
        marginVertical: space.sm,
        borderRadius: radius.md,
        backgroundColor: colors.negativeSoft,
      }}
    >
      <View style={{ paddingTop: 1 }}>
        <Icon name="exclamationmark.triangle" size={18} color={colors.negative} />
      </View>
      <View style={{ flex: 1, gap: space.xs }}>
        <T variant="subhead" tone="negative">
          {error}
        </T>
        {onRetry && (
          <View style={{ alignSelf: "flex-start" }}>
            <Button role="plain" size="medium" onPress={onRetry}>
              Try again
            </Button>
          </View>
        )}
      </View>
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
