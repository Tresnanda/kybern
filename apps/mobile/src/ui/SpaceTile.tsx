// A space's tile, as the desktop rail draws it: the logo the user chose (an
// uploaded image, a curated glyph) on the space's colour, else its initials
// (or a sparkle when the name has none). An image shows the swatch while it loads.
import { spaceInitials } from "../../../../packages/kybern-client/src/spaces";
import type { Space, SpaceColor } from "../state/protocol";
import { StyleSheet, View } from "react-native";
import { assetSource } from "../state/machineRequests";
import type { IconName } from "./icons";
import { Icon, T } from "./primitives";
import { radius, useTheme } from "./theme";
import { AuthedImage } from "./AuthedImage";

/** The desktop's curated logo slugs (`SPACE_ICONS`) as app icons; unknown slugs draw initials. */
const SPACE_GLYPHS: Record<string, IconName> = {
  briefcase: "briefcase",
  building: "building.2",
  team: "person.3",
  user: "person",
  rocket: "paperplane",
  target: "target",
  idea: "lightbulb",
  code: "chevron.left.forwardslash.chevron.right",
  terminal: "terminal",
  cpu: "cpu",
  server: "server.rack",
  database: "cylinder.split.1x2",
  robot: "cpu",
  atom: "atom",
  lab: "flask",
  book: "book",
  pen: "pencil",
  paint: "paintbrush",
  camera: "camera",
  music: "music.note",
  game: "gamecontroller",
  puzzle: "puzzlepiece.extension",
  package: "shippingbox",
  globe: "globe",
  leaf: "leaf",
  coffee: "cup.and.saucer",
  heart: "heart",
  star: "star",
  flash: "bolt",
  shield: "shield",
  wallet: "creditcard",
};

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

export function SpaceTile({
  space,
  size = 20,
  machineId,
}: {
  space: Pick<Space, "name" | "color"> & { logo?: Space["logo"] };
  size?: number;
  /** The machine that owns the space. */
  machineId?: string;
}) {
  const { colors } = useTheme();
  const swatch = SPACE_SWATCHES[space.color] ?? SPACE_SWATCHES.graphite;
  const initials = spaceInitials(space.name).slice(0, size < 24 ? 1 : 2);
  const logo = space.logo;
  const glyph = logo?.kind === "icon" ? SPACE_GLYPHS[logo.icon] : undefined;
  // A space's logo lives on the machine that owns the space; the computer the phone is at when that is unknown.
  const image = logo?.kind === "image" ? assetSource(logo.asset_id, machineId ? { machineId } : {}) : undefined;
  const corner = size >= 28 ? radius.sm - 2 : radius.xs;
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: corner,
        backgroundColor: swatch.fill,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {image ? (
        <>
          <AuthedImage source={image} resizeMode="cover" style={{ width: size, height: size }} />
          {/* A hairline keeps a light image from melting into a light surface. */}
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { borderRadius: corner, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }]}
          />
        </>
      ) : glyph ? (
        <Icon name={glyph} size={size * 0.6} color={swatch.fg} />
      ) : initials ? (
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
