// A space's tile: its colour with its initials (or a star when the name has
// none), the same swatches as the desktop rail. Image logos fall back to the
// tile: the phone doesn't fetch them for a 20 pt mark.
import { spaceInitials } from "../../../../packages/kybern-client/src/spaces";
import type { Space, SpaceColor } from "../state/protocol";
import { View } from "react-native";
import { Icon, T } from "./primitives";
import { radius } from "./theme";

/** One fill per swatch in both themes; white initials except on amber. */
export const SPACE_SWATCHES: Record<SpaceColor, { fill: string; fg: string }> = {
  blue: { fill: "#2F6FEB", fg: "#FFFFFF" },
  green: { fill: "#178A49", fg: "#FFFFFF" },
  purple: { fill: "#7346DB", fg: "#FFFFFF" },
  pink: { fill: "#C93A75", fg: "#FFFFFF" },
  teal: { fill: "#0F8A83", fg: "#FFFFFF" },
  amber: { fill: "#E09A1A", fg: "#1F1405" },
  red: { fill: "#D23F33", fg: "#FFFFFF" },
  graphite: { fill: "#5B6270", fg: "#FFFFFF" },
};

export function SpaceTile({ space, size = 20 }: { space: Pick<Space, "name" | "color">; size?: number }) {
  const swatch = SPACE_SWATCHES[space.color] ?? SPACE_SWATCHES.graphite;
  const initials = spaceInitials(space.name).slice(0, size < 24 ? 1 : 2);
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: size >= 28 ? radius.sm - 2 : radius.xs,
        backgroundColor: swatch.fill,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {initials ? (
        <T
          variant="caption"
          maxFontSizeMultiplier={1}
          style={{ color: swatch.fg, fontWeight: "700", fontSize: size * 0.5, lineHeight: size * 0.62 }}
        >
          {initials}
        </T>
      ) : (
        <Icon name="sparkle" size={size * 0.6} color={swatch.fg} />
      )}
    </View>
  );
}
