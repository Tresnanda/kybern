// The bookends of a subagent's transcript: where the conversation comes from (the first row,
// once the oldest page is loaded) and, once it settled, what it handed back and to whom.
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { clockTime } from "../../../../packages/kybern-client/src/requestCards";
import { subagentThreadPhase } from "../../../../packages/kybern-client/src/subagents";
import type { Thread } from "../state/protocol";
import { useApp } from "../state/runtime";
import { Icon, T, Tap } from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { space, useTheme } from "../ui/theme";

function Rule() {
  const { colors } = useTheme();
  return <View style={{ flex: 1, minWidth: space.lg, height: StyleSheet.hairlineWidth, backgroundColor: colors.line }} />;
}

function useParent(thread: Thread) {
  const app = useApp();
  return thread.parent_thread_id ? app.threads.find((item) => item.id === thread.parent_thread_id) : undefined;
}

/** "— Subagent of Fix the sidebar · 14:02 —", the parent tappable. */
export function SubagentDivider({ thread }: { thread: Thread }) {
  const parent = useParent(thread);
  const started = thread.subagent?.started_at ? clockTime(thread.subagent.started_at) : "";
  const name = parent?.title?.trim() || "its parent";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingTop: space.sm }}>
      <Rule />
      <Tap
        label={parent ? `Subagent of ${name}. Open the parent thread` : `Subagent of ${name}`}
        disabled={!parent}
        onPress={() => parent && router.push({ pathname: "/thread/[id]", params: { id: parent.id } })}
        style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, flexShrink: 1 }}
      >
        <ProviderMark kind={thread.provider.kind} size={12} />
        <T variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1, fontWeight: "500" }}>
          {`Subagent of ${name}${started ? ` · ${started}` : ""}`}
        </T>
      </Tap>
      <Rule />
    </View>
  );
}

/** "— ✓ Result returned to Fix the sidebar —" once the subagent settled; nothing while it works. */
export function SubagentEndRow({ thread }: { thread: Thread }) {
  const { colors } = useTheme();
  const parent = useParent(thread);
  const phase = subagentThreadPhase(thread);
  if (phase === "working") return null;
  const name = parent?.title?.trim() || "its parent";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingTop: space.xl }} accessibilityRole="text">
      <Rule />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, flexShrink: 1 }}>
        {phase !== "stopped" && (
          <Icon name={phase === "failed" ? "exclamationmark.circle" : "checkmark"} size={12} color={phase === "failed" ? colors.negative : colors.muted} />
        )}
        <T variant="caption" tone={phase === "failed" ? "negative" : "muted"} numberOfLines={1} style={{ flexShrink: 1, fontWeight: "500" }}>
          {phase === "done" ? `Result returned to ${name}` : phase === "failed" ? `Failure reported to ${name}` : "Stopped"}
        </T>
      </View>
      <Rule />
    </View>
  );
}
