import { useMemo } from "react";
import { SvgXml } from "react-native-svg";
import marks from "../generated/provider-marks.json";
import type { ProviderKind } from "../state/protocol";
import { useTheme } from "./theme";
export function ProviderMark({
  kind,
  size = 20,
  color,
}: {
  kind: ProviderKind;
  size?: number;
  color?: string;
}) {
  const { colors, dark } = useTheme();
  const source = kind === "opencode" && dark ? marks.opencodeDark : marks[kind];
  const ink = color ?? colors.ink;
  // Resolve XML paint explicitly: currentColor inheritance can stay black on native.
  // Keep the original brand colors and gradients for non-monochrome artwork.
  const xml = useMemo(
    () => source.replaceAll("currentColor", ink),
    [source, ink],
  );
  return (
    <SvgXml
      xml={xml}
      width={size}
      height={size}
      color={ink}
      accessible={false}
    />
  );
}
