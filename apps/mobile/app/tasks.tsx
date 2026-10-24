// Agents & processes full screen (deep links, "/activity"), and one runtime task's
// activity page. The list is the Agents sheet's list.
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { runtimeTaskState } from "../../../packages/kybern-client/src/statusWords";
import { formatElapsed, formatTokenCount } from "../../../packages/kybern-client/src/subagents";
import { AgentsList, useAgents, type AgentsSegment } from "../src/features/AgentsSheet";
import { TaskControls } from "../src/features/Tasks";
import { TranscriptBlock } from "../src/features/Transcript";
import { useApp, useThread, taskActive } from "../src/state/runtime";
import { InsetGroup, ListRow, SectionHeader } from "../src/ui/List";
import { Page, T } from "../src/ui/primitives";
import { StatusGlyph } from "../src/ui/TaskGlyphs";
import { radius, space, useTheme } from "../src/ui/theme";

export default function Tasks() {
  const { threadId = "", taskId } = useLocalSearchParams<{
    threadId: string;
    taskId?: string;
  }>();
  const { colors } = useTheme();
  const app = useApp();
  const snapshot = useThread(threadId);
  const thread = app.threads.find((t) => t.id === threadId) ?? snapshot.thread;
  const model = useAgents(thread, snapshot.tasks, { live: !taskId, active: !taskId });
  const [segment, setSegment] = useState<AgentsSegment>("agents");
  const task = snapshot.tasks.find((t) => t.id === taskId);
  const children = snapshot.tasks.filter((t) => t.parent_id === taskId);
  const activity = taskId
    ? (snapshot.taskActivity[taskId] ??
      snapshot.blocks.filter(
        (b) => b.kind === "tool" && b.call.id === task?.tool_call_id,
      ))
    : [];
  if (!taskId)
    return (
      <Page grouped>
        <AgentsList threadId={threadId} model={model} segment={segment} onSegment={setSegment} />
      </Page>
    );
  const state = task ? runtimeTaskState(task.status, task.backgrounded) : null;
  const duration =
    task?.stats.duration_ms != null
      ? formatElapsed(task.stats.duration_ms)
      : task?.completed_at
        ? formatElapsed(Date.parse(task.completed_at) - Date.parse(task.started_at))
        : null;
  const facts = task
    ? [
        ["Status", state!.word],
        task.model ? ["Model", task.effort ? `${task.model} · ${task.effort}` : task.model] : null,
        duration ? ["Duration", duration] : null,
        formatTokenCount(task.stats.token_count) ? ["Tokens", formatTokenCount(task.stats.token_count)!] : null,
        task.stats.tool_uses != null ? ["Tool uses", String(task.stats.tool_uses)] : null,
      ].filter((fact): fact is [string, string] => !!fact)
    : [];
  return (
    <Page grouped>
      <Stack.Screen
        options={{
          title: task?.kind === "agent" ? "Agent activity" : "Process",
          headerStyle: { backgroundColor: colors.grouped },
        }}
      />
      {!task ? (
        <T tone="secondary">This task is no longer reported. Go back to the thread and open it again.</T>
      ) : (
        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <StatusGlyph phase={state!.phase} size={18} animated={taskActive(task)} />
            <T variant="footnote" tone="secondary">
              {state!.word}
            </T>
          </View>
          {task.kind === "agent" ? (
            <T variant="title">{task.title}</T>
          ) : (
            <View style={{ padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface }}>
              <T variant="mono" selectable>
                {task.title}
              </T>
            </View>
          )}
          {task.detail ? (
            <T variant="subhead" tone="secondary" selectable>
              {task.detail}
            </T>
          ) : null}
          <InsetGroup style={{ marginTop: space.md }}>
            {facts.map(([title, value]) => (
              <ListRow key={title} title={title} value={value} />
            ))}
            {task.parent_id ? (
              <ListRow
                title="Open parent agent"
                chevron
                onPress={() => router.push({ pathname: "/tasks", params: { threadId, taskId: task.parent_id! } })}
              />
            ) : null}
          </InsetGroup>
          <TaskControls task={task} />
          {children.length > 0 && (
            <>
              <SectionHeader title="Started by this agent" count={children.length} inset />
              <InsetGroup>
                {children.map((child) => {
                  const childState = runtimeTaskState(child.status, child.backgrounded);
                  return (
                    <ListRow
                      key={child.id}
                      title={child.title}
                      mono={child.kind !== "agent"}
                      subtitle={childState.word}
                      leading={<StatusGlyph phase={childState.phase} size={18} animated={taskActive(child)} />}
                      chevron
                      onPress={() => router.push({ pathname: "/tasks", params: { threadId, taskId: child.id } })}
                    />
                  );
                })}
              </InsetGroup>
            </>
          )}
          <SectionHeader title="Activity" inset />
          {activity.map((block) => (
            <TranscriptBlock key={`${block.kind}:${block.id}`} block={block} threadId={threadId} />
          ))}
          {!activity.length && (
            <T variant="footnote" tone="muted" style={{ paddingHorizontal: space.lg }}>
              {taskActive(task)
                ? "Activity appears here as the agent reports it."
                : "This agent didn't report separate activity for this task."}
            </T>
          )}
        </View>
      )}
    </Page>
  );
}
