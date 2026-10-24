// A plan limit as a ring: the share used, coloured only near the limit.
import Svg, { Circle } from "react-native-svg";
import { useTheme } from "../../ui/theme";
import { limitTone } from "./labels";

export function UsageRing({ percent, size = 24 }: { percent: number | null; size?: number }) {
  const { colors } = useTheme();
  const stroke = 3;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const used = percent ?? 0;
  return (
    <Svg width={size} height={size} accessible={false}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.raised} strokeWidth={stroke} fill="none" />
      {used > 0 ? (
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors[limitTone(percent)]}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${(circumference * used) / 100} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      ) : null}
    </Svg>
  );
}
