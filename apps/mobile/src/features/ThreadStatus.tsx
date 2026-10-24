// The one-line status strip at the top of the thread's bottom bar (ux-thread H13):
// "Working · 1m 12s", "Waiting for your approval", "Preparing worktree…". It sits on
// the bar's material, so a reader following the output always sees it. The elapsed
// clock ticks in this component only; the screen does not re-render every second.
import { useEffect, useMemo, useState } from "react";
import { AppState, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { PREPARING_WORKTREE } from "../../../../packages/kybern-client/src/newChat";
import { formatElapsed } from "../../../../packages/kybern-client/src/subagents";
import { DURATION } from "../components/liquid/motion";
import type { ThreadState } from "../state/transcript";
import { T } from "../ui/primitives";
import { StatusGlyph } from "../ui/TaskGlyphs";
import { space } from "../ui/theme";

export type StripStatus = "working" | "approval" | "question" | "preparing";

const WORDS: Record<Exclude<StripStatus, "working">, string> = {
  approval: "Waiting for your approval",
  question: "Waiting for your answer",
  preparing: PREPARING_WORKTREE,
};

/** When the running turn started: its last user message. */
function turnStart(blocks: ThreadState["blocks"]) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "user") {
      const at = Date.parse(block.at);
      return Number.isFinite(at) ? at : null;
    }
  }
  return null;
}

export function StatusStrip({
  status,
  blocks,
  active,
}: {
  threadId: string;
  status: StripStatus;
  blocks: ThreadState["blocks"];
  active: boolean;
}) {
  const started = useMemo(() => turnStart(blocks), [blocks]);
  const [now, setNow] = useState(Date.now);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setForeground(s === "active"));
    return () => sub.remove();
  }, []);
  const ticking = status === "working" && active && foreground && started != null;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const text =
    status === "working"
      ? started != null
        ? `Working · ${formatElapsed(now - started)}`
        : "Working"
      : WORDS[status];
  const waiting = status === "approval" || status === "question";
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={status === "working" ? "Working" : text}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 28 }}
    >
      <StatusGlyph phase={waiting ? "waiting" : "working"} size={15} animated={active} />
      {/* Cross-fade when the status changes; the clock itself never animates. */}
      <Animated.View key={status} entering={FadeIn.duration(DURATION.state)} style={{ flex: 1 }}>
        <T
          variant="footnote"
          tone={waiting ? "warning" : "secondary"}
          numberOfLines={1}
          style={{ fontWeight: "500", fontVariant: ["tabular-nums"] }}
        >
          {text}
        </T>
      </Animated.View>
    </View>
  );
}
