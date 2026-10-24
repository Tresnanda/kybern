// A list row with a leading round check, for choosing several items (group
// repositories, worktree copies). The whole row is the target, so the gap
// between the check and its label is never a dead zone. Same on both
// platforms: an opaque themed control, not a stock Android checkbox.
import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import Animated, { Easing, Keyframe, cubicBezier } from "react-native-reanimated";
import { Icon, T } from "./primitives";
import { useTheme } from "./theme";

// Ticking fills the check from 0.9 with the Tap curve; Reduce Motion skips it and the fill just appears.
const fill = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.9 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.bezier(0.23, 1, 0.32, 1) },
}).duration(120);

export function Check({ checked, size = 24 }: { checked: boolean; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: checked ? 0 : 1.5,
        borderColor: colors.muted,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked && (
        <Animated.View
          entering={fill}
          style={{
            position: "absolute",
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="checkmark" size={Math.round(size * 0.6)} color="#FFFFFF" />
        </Animated.View>
      )}
    </View>
  );
}

export function CheckRow({
  title,
  titleDetail,
  detail,
  detailTone = "secondary",
  checked,
  onToggle,
  disabled,
  trailing,
}: {
  title: string;
  /** Muted text after the title on the same line ("· main"). */
  titleDetail?: string;
  detail?: string;
  detailTone?: "secondary" | "negative" | "warning";
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={[title, titleDetail, detail].filter(Boolean).join(", ")}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync();
        onToggle();
      }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      pressRetentionOffset={16}
    >
      <Animated.View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 14,
          minHeight: 52,
          paddingVertical: 10,
          opacity: disabled ? 0.38 : pressed ? 0.72 : 1,
          transitionProperty: "opacity",
          transitionDuration: 120,
          transitionTimingFunction: cubicBezier(0.23, 1, 0.32, 1),
        }}
      >
        <Check checked={checked} />
        <View style={{ flex: 1, gap: 3 }}>
          <T variant="label" numberOfLines={1}>
            {title}
            {titleDetail ? (
              <T variant="footnote" tone="muted">
                {` · ${titleDetail}`}
              </T>
            ) : null}
          </T>
          {!!detail && (
            <T variant="footnote" tone={detailTone}>
              {detail}
            </T>
          )}
        </View>
        {trailing}
      </Animated.View>
    </Pressable>
  );
}
