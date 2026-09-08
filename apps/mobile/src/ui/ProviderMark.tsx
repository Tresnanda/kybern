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
  const xml = kind === "opencode" && dark ? marks.opencodeDark : marks[kind];
  return (
    <SvgXml
      xml={xml}
      width={size}
      height={size}
      color={color ?? colors.ink}
      accessible={false}
    />
  );
}
