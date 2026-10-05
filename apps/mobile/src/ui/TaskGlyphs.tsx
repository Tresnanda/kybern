// The small marks Tasks is drawn with, matching the desktop: Linear-style status
// glyphs (the only place status color lives), priority bars and project dots.
import { memo, useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";
import type { TaskPriority, TaskStatus } from "../state/protocol";
import { useProjects } from "../state/runtime";
import { projectColor } from "../state/tasksModel";
import { useTheme } from "./theme";

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** Status and priority colors per theme, sampled from the approved Tasks design. */
export function taskColors(dark: boolean) {
  return dark
    ? {
        run: "#6AA7F4",
        review: "#EBB353",
        done: "#6DB07F",
        urgent: "#EA7B4E",
        ring: "rgba(255,255,255,0.42)",
        faint: "rgba(255,255,255,0.24)",
      }
    : {
        run: "#276ED2",
        review: "#D48300",
        done: "#388E56",
        urgent: "#D75928",
        ring: "rgba(0,0,0,0.42)",
        faint: "rgba(0,0,0,0.22)",
      };
}

const RUNNING_PIE = "M7 7V3.6A3.4 3.4 0 0 1 7 10.4Z";
const REVIEW_PIE = "M7 7V3.6A3.4 3.4 0 1 1 3.6 7Z";

/** A running pie that breathes slowly while on screen; still when motion is reduced. */
function BreathingPie({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduced) return;
    opacity.value = withRepeat(
      withTiming(0.45, { duration: 1100, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    return () => cancelAnimation(opacity);
  }, [reduced, opacity]);
  const props = useAnimatedProps(() => ({ fillOpacity: opacity.value }));
  return <AnimatedPath d={RUNNING_PIE} fill={color} animatedProps={props} />;
}

/**
 * Dashed circle (inbox), circle (to do), half pie (running), three-quarter pie
 * (needs review), filled check (done), filled cross (canceled).
 */
export const StatusGlyph = memo(function StatusGlyph({
  status,
  size = 16,
  animated = false,
  mono,
}: {
  status: TaskStatus;
  size?: number;
  animated?: boolean;
  /** Draw in this single color (navigation rows). */
  mono?: string;
}) {
  const { colors, dark } = useTheme();
  const c = taskColors(dark);
  const ring = (stroke: string, dashed = false) => (
    <Circle
      cx="7"
      cy="7"
      r="5.75"
      fill="none"
      stroke={stroke}
      strokeWidth="1.5"
      strokeDasharray={dashed ? "1.45 1.56" : undefined}
    />
  );
  let body;
  switch (status) {
    case "inbox":
      body = ring(mono ?? c.ring, true);
      break;
    case "todo":
      body = ring(mono ?? c.ring);
      break;
    case "running":
      body = (
        <>
          {ring(mono ?? c.run)}
          {animated && !mono ? (
            <BreathingPie color={c.run} />
          ) : (
            <Path d={RUNNING_PIE} fill={mono ?? c.run} />
          )}
        </>
      );
      break;
    case "needs_review":
      body = (
        <>
          {ring(mono ?? c.review)}
          <Path d={REVIEW_PIE} fill={mono ?? c.review} />
        </>
      );
      break;
    case "done":
      body = mono ? (
        <>
          {ring(mono)}
          <Path
            d="M4.6 7.1 6.3 8.8 9.5 5.4"
            fill="none"
            stroke={mono}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <Circle cx="7" cy="7" r="6.5" fill={c.done} />
          <Path
            d="M4.4 7.2 6.2 9 9.7 5.2"
            fill="none"
            stroke={colors.background}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
      break;
    case "canceled":
      body = (
        <>
          <Circle cx="7" cy="7" r="6.5" fill={mono ?? c.faint} />
          <Path
            d="M5 5l4 4M9 5 5 9"
            stroke={colors.background}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      );
      break;
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" accessible={false}>
      {body}
    </Svg>
  );
});

/** Priority as Linear's bars; urgent is a filled orange square with "!". */
export const PriorityGlyph = memo(function PriorityGlyph({
  priority,
  size = 14,
  color,
}: {
  priority: TaskPriority;
  size?: number;
  color?: string;
}) {
  const { colors, dark } = useTheme();
  const ink = color ?? colors.secondary;
  if (priority === 0)
    return (
      <Svg width={size} height={size} viewBox="0 0 14 14" accessible={false}>
        <G fill={ink} opacity={0.55}>
          <Rect x="1.5" y="6.25" width="2.6" height="1.5" rx=".75" />
          <Rect x="5.7" y="6.25" width="2.6" height="1.5" rx=".75" />
          <Rect x="9.9" y="6.25" width="2.6" height="1.5" rx=".75" />
        </G>
      </Svg>
    );
  if (priority === 1)
    return (
      <Svg width={size} height={size} viewBox="0 0 14 14" accessible={false}>
        <Rect x="1" y="1" width="12" height="12" rx="3" fill={taskColors(dark).urgent} />
        <Path d="M7 3.9v3.6" stroke={colors.background} strokeWidth="1.6" strokeLinecap="round" />
        <Circle cx="7" cy="9.9" r=".95" fill={colors.background} />
      </Svg>
    );
  const filled = { 2: 3, 3: 2, 4: 1 }[priority];
  const bars: [number, number, number][] = [
    [1.5, 8, 4],
    [5.75, 5, 7],
    [10, 2, 10],
  ];
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" accessible={false}>
      {bars.map(([x, y, h], index) => (
        <Rect
          key={x}
          x={x}
          y={y}
          width="2.5"
          height={h}
          rx=".8"
          fill={ink}
          opacity={index < filled ? 1 : 0.3}
        />
      ))}
    </Svg>
  );
});

/** A project's dot in its own soft hue; Global is a hollow ring. */
export function ProjectDot({
  projectId,
  size = 7,
}: {
  projectId: string | null | undefined;
  size?: number;
}) {
  const { dark } = useTheme();
  const projects = useProjects();
  const c = taskColors(dark);
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        ...(projectId
          ? { backgroundColor: projectColor(projectId, dark, projects) }
          : { borderWidth: 1.25, borderColor: c.ring }),
      }}
    />
  );
}
