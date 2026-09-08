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
import { Button, ErrorBanner, Icon, T, Tap, styles } from "../ui/primitives";
import { useTheme } from "../ui/theme";
export function TaskRow({ task }: { task: RuntimeTask }) {
  const { colors } = useTheme();
  return (
    <Tap
      label={`${task.title}, ${task.status}${task.backgrounded ? ", background" : ""}. Open activity`}
      onPress={() =>
        router.push({
          pathname: "/tasks",
          params: { threadId: task.thread_id, taskId: task.id },
        })
      }
      style={[styles.line, { paddingVertical: 10 }]}
    >
      <Icon
        name={
          task.kind === "agent"
            ? "person.crop.circle"
            : task.kind === "monitor"
              ? "waveform.path"
              : "terminal"
        }
        size={19}
        color={
          task.status === "failed"
            ? colors.negative
            : taskActive(task)
              ? colors.accent
              : colors.secondary
        }
      />
      <View style={{ flex: 1 }}>
        <T variant="label">{task.title}</T>
        <T variant="caption" tone="secondary">
          {task.status}
          {task.backgrounded ? " · Background" : ""}
          {task.model ? ` · ${task.model}` : ""}
          {task.stats.token_count != null
            ? ` · ${task.stats.token_count.toLocaleString()} tokens`
            : ""}
        </T>
      </View>
      <Icon name="chevron.right" size={10} />
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
              secondary
              busy={busy}
              disabled={app.status !== "open"}
              onPress={() => void control("tasks.background")}
            >
              Run in background
            </Button>
          )}
          {task.capabilities.stop && (
            <Button
              secondary
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
