// Held messages for a thread, opened from the bottom bar's held message or "N held messages" row.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";
import { HeldMessageList } from "../src/features/HeldMessages";
import { useApp, useThreadValue } from "../src/state/runtime";
import type { ThreadState } from "../src/state/transcript";
import { space, useTheme } from "../src/ui/theme";

const threadOf = (snapshot: ThreadState) => snapshot.thread;

export default function HeldSheet() {
  const { threadId = "" } = useLocalSearchParams<{ threadId: string }>();
  const { colors } = useTheme();
  const app = useApp();
  const loaded = useThreadValue(threadId, threadOf);
  const thread = app.threads.find((t) => t.id === threadId) ?? loaded;
  return (
    <>
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.grouped } }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: colors.grouped }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space["3xl"] }}
      >
        <HeldMessageList thread={thread} onEmpty={() => router.canGoBack() && router.back()} />
      </ScrollView>
    </>
  );
}
