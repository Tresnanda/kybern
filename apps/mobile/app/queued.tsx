// Queued messages for a running thread, opened from the bottom bar's "N queued" capsule.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { ScrollView } from "react-native";
import { QueuedPrompts } from "../src/features/QueuedPrompts";
import { useApp } from "../src/state/runtime";
import { SectionFooter } from "../src/ui/List";
import { space, useTheme } from "../src/ui/theme";

export default function QueuedSheet() {
  const { threadId = "" } = useLocalSearchParams<{ threadId: string }>();
  const { colors } = useTheme();
  const app = useApp();
  const items = app.queue.filter((item) => item.thread_id === threadId);
  // The queue drained (the turn picked them up): nothing left to show.
  useEffect(() => {
    if (!items.length && router.canGoBack()) router.back();
  }, [items.length]);
  return (
    <>
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.grouped } }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, backgroundColor: colors.grouped }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space["3xl"] }}
      >
        <QueuedPrompts items={items} />
        <SectionFooter inset>These send in order when the current turn ends.</SectionFooter>
      </ScrollView>
    </>
  );
}
