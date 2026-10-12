// A few mutually exclusive values on one opaque track: the chosen segment is a raised,
// solid surface. Same on both platforms, so Android keeps its own themed controls and
// menus stay readable; every segment is a full-height touch target.
import { Platform, View } from "react-native";
import { T, Tap } from "./primitives";
import { useTheme } from "./theme";

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  disabled,
  label,
}: {
  options: readonly { value: V; label: string }[];
  value: V;
  onChange: (value: V) => void;
  disabled?: boolean;
  /** What the control chooses, for screen readers ("Before starting work"). */
  label: string;
}) {
  const { colors, dark } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ flexDirection: "row", padding: 3, gap: 2, borderRadius: 14, backgroundColor: colors.raised }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Tap
            key={option.value}
            label={option.label}
            selected={selected}
            disabled={disabled}
            static
            onPress={() => {
              if (!selected) onChange(option.value);
            }}
            style={{
              flex: 1,
              minHeight: 40,
              paddingHorizontal: 6,
              alignItems: "center",
              borderRadius: 11,
              backgroundColor: selected ? (dark ? colors.line : colors.surface) : "transparent",
              ...(selected && Platform.OS === "ios" && !dark
                ? { shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } }
                : {}),
              ...(selected && Platform.OS === "android" ? { elevation: dark ? 0 : 1 } : {}),
            }}
          >
            <T variant="caption" tone={selected ? "ink" : "secondary"} numberOfLines={1} style={selected ? { fontWeight: "600" } : undefined}>
              {option.label}
            </T>
          </Tap>
        );
      })}
    </View>
  );
}
