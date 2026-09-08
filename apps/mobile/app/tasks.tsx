import { Stack, router, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { TaskControls, TaskRow } from "../src/features/Tasks";
import { TranscriptBlock } from "../src/features/Transcript";
import { useThread, taskActive } from "../src/state/runtime";
import { Empty, Page, T, Tap } from "../src/ui/primitives";
export default function Tasks() {
  const { threadId = "", taskId } = useLocalSearchParams<{
    threadId: string;
    taskId?: string;
  }>();
  const snapshot = useThread(threadId);
  const task = snapshot.tasks.find((t) => t.id === taskId);
  const children = snapshot.tasks.filter((t) => t.parent_id === taskId);
  const activity = taskId
    ? (snapshot.taskActivity[taskId] ??
      snapshot.blocks.filter(
        (b) => b.kind === "tool" && b.call.id === task?.tool_call_id,
      ))
    : [];
  return (
    <Page>
      <Stack.Screen
        options={{
          title:
            task?.kind === "agent"
              ? "Agent activity"
              : task
                ? "Task activity"
                : "Tasks & agents",
        }}
      />
      {task ? (
        <View style={{ gap: 16 }}>
          <T variant="heading">{task.title}</T>
          <T variant="caption" tone="secondary">
            {task.status}
            {task.backgrounded ? " · Background" : ""}
            {task.model ? ` · ${task.model}` : ""}
            {task.effort ? ` · ${task.effort}` : ""}
          </T>
          {task.parent_id && (
            <Tap
              label="Open parent agent"
              onPress={() =>
                router.push({
                  pathname: "/tasks",
                  params: { threadId, taskId: task.parent_id! },
                })
              }
            >
              <T variant="label" tone="accent">
                Open parent agent
              </T>
            </Tap>
          )}
          {task.detail && <T selectable>{task.detail}</T>}
          <TaskControls task={task} />
          {(task.stats.token_count != null ||
            task.stats.tool_uses != null ||
            task.stats.duration_ms != null) && (
            <T
              variant="caption"
              tone="secondary"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {[
                task.stats.token_count != null
                  ? `${task.stats.token_count.toLocaleString()} tokens`
                  : "",
                task.stats.tool_uses != null
                  ? `${task.stats.tool_uses} tool uses`
                  : "",
                task.stats.duration_ms != null
                  ? `${Math.round(task.stats.duration_ms / 1000)}s`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </T>
          )}
          {children.map((child) => (
            <TaskRow key={child.id} task={child} />
          ))}
          {activity.map((block) => (
            <TranscriptBlock
              key={`${block.kind}:${block.id}`}
              block={block}
              threadId={threadId}
            />
          ))}
          {!activity.length && (
            <T variant="caption" tone="secondary">
              {taskActive(task)
                ? "Activity will appear here as the harness reports it."
                : "This harness did not report a separate transcript for this task."}
            </T>
          )}
        </View>
      ) : (
        <>
          {snapshot.tasks
            .filter(
              (t) =>
                !t.parent_id ||
                !snapshot.tasks.some((p) => p.id === t.parent_id),
            )
            .sort((a, b) => Number(taskActive(b)) - Number(taskActive(a)))
            .map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          {!snapshot.tasks.length && (
            <Empty
              title="No tasks yet"
              detail="Agents and background processes appear here when the harness starts them."
            />
          )}
        </>
      )}
    </Page>
  );
}
