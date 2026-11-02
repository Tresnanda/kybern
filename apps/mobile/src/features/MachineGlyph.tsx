import { View } from "react-native";
import type { MachineGlyph as Glyph } from "../../../../packages/kybern-client/src/machineMerge";
import type { MachineConnectionStatus } from "../../../../packages/kybern-client/src/machines";
import { statusTone } from "../machines/labels";
import { T } from "../ui/primitives";
import { radius, useTheme } from "../ui/theme";

/**
 * The machine's monogram: its first letter, tinted from its id so it is the same on every client. Quiet like the
 * desktop's badge (a pale tint with the letter in the machine's colour), so it reads as a label, not an app icon or an
 * unread count. Thread lists name the machine in words instead (`threadMachineWord`).
 */
export function MachineGlyph({ glyph, size = 16 }: { glyph: Glyph; size?: number }) {
  const { dark } = useTheme();
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: radius.xs,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: `hsl(${glyph.hue}, ${dark ? 22 : 40}%, ${dark ? 26 : 91}%)`,
      }}
    >
      <T variant="caption" allowFontScaling={false} style={{ color: `hsl(${glyph.hue}, ${dark ? 55 : 50}%, ${dark ? 78 : 38}%)`, fontWeight: "600", fontSize: Math.round(size * (glyph.letter.length > 1 ? 0.48 : 0.64)), lineHeight: Math.round(size * 0.8) }}>
        {glyph.letter}
      </T>
    </View>
  );
}

/** A machine's connection as a 7 pt dot. */
export function StatusDot({ status, connecting }: { status: MachineConnectionStatus; connecting?: boolean }) {
  const { colors } = useTheme();
  const tone = statusTone(status, connecting);
  return <View accessible={false} style={{ width: 7, height: 7, borderRadius: radius.full, backgroundColor: colors[tone] }} />;
}
