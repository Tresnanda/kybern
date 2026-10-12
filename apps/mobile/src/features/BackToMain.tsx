import { router } from "expo-router";
import { View } from "react-native";
import type { Thread } from "../state/protocol";
import { useApp } from "../state/runtime";
import { Icon, T, Tap, styles } from "../ui/primitives";

/** The topmost known ancestor. A broken chain ends at the last parent id the daemon reported. */
function mainConversation(thread: Thread, threads: readonly Thread[]): { id: string; title?: string } | null {
  const byId = new Map(threads.map((item) => [item.id, item]));
  const seen = new Set<string>([thread.id]);
  let id = thread.parent_thread_id ?? null;
  let found: { id: string; title?: string } | null = null;
  while (id && !seen.has(id)) {
    seen.add(id);
    const parent = byId.get(id);
    found = { id, title: parent?.title };
    id = parent?.parent_thread_id ?? null;
  }
  return found;
}

/** A way back from any thread another thread started (a delegated agent, a subagent) to the conversation that started it. */
export function BackToMain({ thread }: { thread?: Thread | null }) {
  const app = useApp();
  if (!thread?.parent_thread_id) return null;
  const main = mainConversation(thread, app.threads);
  if (!main) return null;
  return (
    <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: 20 }}>
      <Tap
        label={`Back to main conversation${main.title ? `, ${main.title}` : ""}`}
        onPress={() => router.dismissTo({ pathname: "/thread/[id]", params: { id: main.id } })}
        style={[styles.line, { minHeight: 48, gap: 8 }]}
      >
        <Icon name="arrow.turn.up.left" size={15} />
        <T variant="caption" numberOfLines={1} style={{ flex: 1 }}>
          Back to main conversation
        </T>
      </Tap>
    </View>
  );
}
