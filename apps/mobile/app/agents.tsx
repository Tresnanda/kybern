// The Agents sheet (ux-thread H2/H9): opened from the thread's bottom-bar capsule or a
// transcript's "N processes running" row. `/tasks` shows the same list full screen.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView } from "react-native";
import { AgentsList, useAgents, type AgentsSegment } from "../src/features/AgentsSheet";
import { useApp, useThread } from "../src/state/runtime";
import { space, useTheme } from "../src/ui/theme";

export default function AgentsSheet() {
  const { threadId = "", segment: requested } = useLocalSearchParams<{ threadId: string; segment?: string }>();
  const { colors } = useTheme();
  const app = useApp();
  const snapshot = useThread(threadId);
  const thread = app.threads.find((t) => t.id === threadId) ?? snapshot.thread;
  const model = useAgents(thread, snapshot.tasks, { live: true });
  const [segment, setSegment] = useState<AgentsSegment>(
    requested === "processes" || requested === "agents"
      ? requested
      : model.agents.length || !model.processes.length
        ? "agents"
        : "processes",
  );
  return (
    <>
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.grouped } }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: colors.grouped }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space["3xl"] }}
      >
        <AgentsList
          threadId={threadId}
          model={model}
          segment={segment}
          onSegment={setSegment}
          onOpen={(row) => {
            // Close the sheet first so the destination is pushed on the stack, not under it.
            router.back();
            if ("thread" in row.target) router.push({ pathname: "/thread/[id]", params: { id: row.target.thread } });
            else router.push({ pathname: "/tasks", params: { threadId, taskId: row.target.task } });
          }}
        />
      </ScrollView>
    </>
  );
}
