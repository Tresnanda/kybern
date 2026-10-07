import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import type { Thread } from "../state/protocol";
import { childIsRunning, childStatusWord, sortChildren } from "../state/orchestration";
import { rpc, useApp } from "../state/runtime";
import { Icon, T, Tap, styles } from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { useTheme } from "../ui/theme";

const POLL_MS = 5000;

/**
 * Threads this one started: delegated agents and subagents. They are left out of
 * the library, so this list is how you reach them; each row opens the child.
 */
export function ChildThreads({ thread, active = true }: { thread?: Thread | null; active?: boolean }) {
  const app = useApp();
  const { colors } = useTheme();
  const [children, setChildren] = useState<Thread[]>([]);
  const [expanded, setExpanded] = useState(false);
  const generation = useRef(0);
  const id = thread?.id;
  const connected = app.status === "open";
  const load = useCallback(async () => {
    if (!id || !connected) return;
    const current = ++generation.current;
    try {
      const result = await rpc("threads.list", {
        parent_thread_id: id,
        include_archived: true,
      });
      if (current === generation.current) setChildren(sortChildren(result.threads));
    } catch {
      // Keep the last list; the next change or poll retries.
    }
  }, [id, connected]);
  useEffect(() => {
    setChildren([]);
    setExpanded(false);
  }, [id]);
  // Reload when the parent moves; a child's own progress does not reach this thread's events.
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load, thread?.last_seq, thread?.status]);
  const running = children.filter(childIsRunning).length;
  useEffect(() => {
    if (!active || (!running && thread?.status !== "running")) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, running, thread?.status, load]);
  if (!thread || children.length === 0) return null;
  return (
    <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: 20 }}>
      <Tap
        static
        expanded={expanded}
        label={`${expanded ? "Hide" : "Show"} ${children.length} started agents`}
        onPress={() => setExpanded((value) => !value)}
        style={[styles.line, { minHeight: 48, gap: 8 }]}
      >
        <Icon name="person.2" size={18} />
        <T variant="caption" style={{ flex: 1 }}>
          {children.length} {children.length === 1 ? "agent" : "agents"}
        </T>
        {running > 0 && (
          <T variant="caption" tone="secondary">
            {running} running
          </T>
        )}
        <Icon name={expanded ? "chevron.up" : "chevron.down"} size={12} />
      </Tap>
      {expanded && (
        <ScrollView
          keyboardShouldPersistTaps="always"
          style={{ maxHeight: 240 }}
          contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
        >
          {children.map((child) => (
            <Tap
              key={child.id}
              label={`Open ${child.title || "agent"}, ${childStatusWord(child)}`}
              onPress={() =>
                router.push({ pathname: "/thread/[id]", params: { id: child.id } })
              }
              style={[
                styles.line,
                {
                  minHeight: 48,
                  borderRadius: 20,
                  backgroundColor: colors.surface,
                  paddingHorizontal: 12,
                  gap: 7,
                },
              ]}
            >
              <ProviderMark kind={child.provider.kind} size={15} />
              <View style={{ flex: 1, gap: 3 }}>
                <T variant="caption" numberOfLines={2}>
                  {child.title || "Agent"}
                </T>
                <T variant="caption" tone="secondary" numberOfLines={1}>
                  {childStatusWord(child)}
                </T>
              </View>
              <Icon name="chevron.right" size={11} color={colors.muted} />
            </Tap>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
