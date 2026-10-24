import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import type { RuntimeTask } from "../state/protocol";
import {
  errorText,
  loadThread,
  rpc,
  taskActive,
  useApp,
} from "../state/runtime";
import { Button, ErrorBanner, Icon, T, Tap } from "../ui/primitives";
import { StatusGlyph } from "../ui/TaskGlyphs";
import { radius, space, useTheme } from "../ui/theme";
import { runtimeStatus } from "../state/status";
import { workDuration } from "../state/turnRows";
import { displayCommand } from "../../../../packages/kybern-client/src/displayCommand";
import { runtimeTaskStatusWord } from "../../../../packages/kybern-client/src/statusWords";
/** "1m 04s", "12s": how long a task ran, or has been running. */
function elapsed(task: RuntimeTask) {
  const start = Date.parse(task.started_at);
  const end = task.completed_at ? Date.parse(task.completed_at) : Date.now();
  const ms = task.stats.duration_ms ?? (Number.isNaN(start) ? null : end - start);
  return ms == null ? "" : workDuration(ms);
}

/**
 * A runtime task in a list (ux-thread H6): status glyph, the cleaned command in mono on one line
 * (an agent's title in the reading font), then "Completed · 12s" or "Running · 1m 04s".
 */
export function TaskRow({ task }: { task: RuntimeTask }) {
  const { colors } = useTheme();
  const info = runtimeStatus(task.status);
  const agent = task.kind === "agent";
  const title = agent ? task.title : displayCommand(task.title).text;
  const word = runtimeTaskStatusWord(task.status, task.backgrounded);
  const meta = [word, elapsed(task), task.model, task.stats.token_count != null ? `${task.stats.token_count.toLocaleString()} tokens` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tap
      label={`${title}, ${word}. Open activity`}
      feedback="highlight"
      onPress={() =>
        router.push({
          pathname: "/tasks",
          params: { threadId: task.thread_id, taskId: task.id },
        })
      }
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 56, paddingVertical: space.sm, borderRadius: radius.sm }}
    >
      <StatusGlyph phase={info.phase} size={18} animated={info.active} />
      <View style={{ flex: 1, gap: space["2xs"] }}>
        <T variant={agent ? "subhead" : "code"} numberOfLines={1} style={{ fontWeight: agent ? "500" : undefined }}>
          {title}
        </T>
        <T variant="footnote" tone={info.phase === "failed" ? "negative" : "secondary"} numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
          {meta}
        </T>
      </View>
      <Icon name="chevron.right" size={12} color={colors.muted} />
    </Tap>
  );
}
export function TaskControls({ task }: { task: RuntimeTask }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function control(method: "tasks.stop" | "tasks.background") {
    setBusy(true);
    setError("");
    try {
      await rpc(method, { thread_id: task.thread_id, task_id: task.id });
      await loadThread(task.thread_id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 8 }}>
      <ErrorBanner error={error} />
      {taskActive(task) && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {task.capabilities.background && !task.backgrounded && (
            <Button
              busy={busy}
              disabled={app.status !== "open"}
              onPress={() => void control("tasks.background")}
            >
              Run in background
            </Button>
          )}
          {task.capabilities.stop && (
            <Button
              busy={busy}
              disabled={app.status !== "open"}
              onPress={() => void control("tasks.stop")}
            >
              {task.kind === "agent" ? "Stop agent" : "Stop task"}
            </Button>
          )}
        </View>
      )}
    </View>
  );
}
