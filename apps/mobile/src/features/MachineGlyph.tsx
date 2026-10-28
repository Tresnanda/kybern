import { View } from "react-native";
import type { MachineGlyph as Glyph } from "../../../../packages/kybern-client/src/machineMerge";
import type { MachineConnectionStatus } from "../../../../packages/kybern-client/src/machines";
import { statusTone } from "../machines/labels";
import { T } from "../ui/primitives";
import { radius, useTheme } from "../ui/theme";

/**
 * The machine's monogram: its first letter on a colour taken from its id, the
 * same on every client. Shown on a thread only when more than one machine is
 * known and the thread is not on the machine the phone is at.
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
        backgroundColor: `hsl(${glyph.hue}, 48%, ${dark ? 40 : 44}%)`,
      }}
    >
      <T variant="caption" allowFontScaling={false} style={{ color: "#FFFFFF", fontWeight: "700", fontSize: Math.round(size * 0.62), lineHeight: Math.round(size * 0.8) }}>
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
