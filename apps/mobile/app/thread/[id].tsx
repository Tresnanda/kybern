// A thread: the transcript scrolling under a transparent header, the glass
// composer riding the keyboard, and any approval fused above it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";
import { useConnection } from "@/connection/ConnectionContext";
import { formatDuration, formatTokens } from "@/lib/time";
import type { ApprovalDecision, ApprovalRequest, PermissionMode, TranscriptEntry } from "@/protocol";
import { forgetApproval, patchThread } from "@/state/daemon";
import { applyEvent, emptyThreadState, removeApproval, seedFromGet, type ThreadState } from "@/state/transcript";
import { ApprovalCard } from "@/ui/ApprovalCard";
import { ConnectionBanner } from "@/ui/Banner";
import { Composer } from "@/ui/Composer";
import { Markdown } from "@/ui/Markdown";
import { EmptyState, Screen, Txt } from "@/ui/Screen";
import { Thinking } from "@/ui/Thinking";
import { ToolRow } from "@/ui/ToolRow";
import { GUTTER, radius, space, useTheme } from "@/ui/theme";

type Row = { key: string; entry: TranscriptEntry };

const MODE_LABEL: Record<PermissionMode, string> = {
  supervised: "Supervised",
  "accept-edits": "Accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export default function ThreadScreen() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client, status, statusDetail } = useConnection();
  const [state, setState] = useState<ThreadState>(emptyThreadState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dockHeight, setDockHeight] = useState(96);
  const listRef = useRef<FlashListRef<Row>>(null);

  // Seed from threads.get, then subscribe from the seed's last_seq so nothing
  // between the two calls is lost. Reconnects replay inside the client.
  useEffect(() => {
    if (!client || !id) return;
    let cancelled = false;
    let sub: ReturnType<typeof client.subscribeEvents> | null = null;

    const seed = async () => {
      try {
        const res = await client.call("threads.get", { thread_id: id });
        if (cancelled) return;
        setState(seedFromGet(res));
        setLoaded(true);
        setLoadError(null);
        sub?.unsubscribe();
        sub = client.subscribeEvents(
          { thread_id: id, after_seq: res.thread.last_seq },
          (ev) => setState((s) => applyEvent(s, ev)),
          () => {
            client
              .call("threads.get", { thread_id: id })
              .then((r) => {
                if (cancelled) return;
                setState((s) => (r.thread.last_seq > s.lastSeq ? seedFromGet(r) : { ...s, pendingApprovals: r.pending_approvals }));
              })
              .catch(() => {});
          },
        );
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    };

    if (client.status === "open") void seed();
    const off = client.onStatus((s) => {
      if (s === "open" && !sub) void seed();
    });
    return () => {
      cancelled = true;
      off();
      sub?.unsubscribe();
    };
  }, [client, id]);

  useEffect(() => {
    if (state.thread) patchThread(state.thread);
  }, [state.thread]);

  const rows = useMemo<Row[]>(() => state.entries.map((entry, i) => ({ key: entryKey(entry, i), entry })), [state.entries]);

  const respond = useCallback(
    async (approval: ApprovalRequest, decision: ApprovalDecision) => {
      if (!client) throw new Error("Not connected");
      await client.call("approvals.respond", { approval_id: approval.id, ...decision });
      setState((s) => removeApproval(s, approval.id));
      forgetApproval(approval.id);
    },
    [client],
  );

  const send = useCallback(
    async (text: string) => {
      if (!client || !id) throw new Error("Not connected");
      await client.call("threads.send", { thread_id: id, message: { parts: [{ type: "text", text }] } });
      listRef.current?.scrollToEnd({ animated: true });
    },
    [client, id],
  );

  const interrupt = useCallback(async () => {
    if (!client || !id) return;
    await client.call("threads.interrupt", { thread_id: id }).catch(() => {});
  }, [client, id]);

  const setMode = async (mode: PermissionMode) => {
    if (!client || !id) return;
    const next = await client.call("threads.update", { thread_id: id, permission_mode: mode });
    setState((s) => ({ ...s, thread: next }));
  };
  const togglePin = async () => {
    if (!client || !id || !state.thread) return;
    const next = await client.call("threads.update", { thread_id: id, pinned: !state.thread.pinned });
    setState((s) => ({ ...s, thread: next }));
  };
  const archive = async () => {
    if (!client || !id) return;
    await client.call("threads.archive", { thread_id: id });
    if (state.thread) patchThread({ ...state.thread, status: "archived" });
    router.back();
  };

  const thread = state.thread;
  const working = thread?.status === "running";
  const streaming = working && !state.entries.some((e) => e.role === "assistant" && !e.complete && e.text.length > 0);

  return (
    <Screen>
      <Stack.Screen options={{ title: thread?.title || "Thread", headerLargeTitleEnabled: false }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="Thread options">
          <Stack.Toolbar.MenuAction icon={thread?.pinned ? "pin.slash" : "pin"} onPress={() => void togglePin()}>
            {thread?.pinned ? "Unpin" : "Pin"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.Menu title="Permissions" icon="shield" inline>
            {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => (
              <Stack.Toolbar.MenuAction key={m} isOn={thread?.permission_mode === m} onPress={() => void setMode(m)}>
                {MODE_LABEL[m]}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.MenuAction icon="archivebox" destructive onPress={() => void archive()}>
            Archive
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <ConnectionBanner status={status} detail={statusDetail} error={loadError} />

      <FlashList
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={({ item }) => <EntryView entry={item.entry} />}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: Platform.OS === "android" ? space.md : space.sm, paddingBottom: dockHeight + space.lg }}
        keyboardDismissMode="interactive"
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.2, startRenderingFromBottom: true, animateAutoScrollToBottom: false }}
        ListFooterComponent={streaming ? <View style={styles.block}><Thinking /></View> : null}
        ListEmptyComponent={loaded ? <EmptyState title="Nothing here yet" hint="Send a message to start the conversation." /> : null}
      />

      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }} style={styles.dock}>
        <Animated.View layout={LinearTransition.springify().damping(20).stiffness(220)} onLayout={(e) => setDockHeight(e.nativeEvent.layout.height)} style={[styles.dockInner, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
          {state.pendingApprovals.map((a) => (
            <View key={a.id} style={styles.approval}>
              <ApprovalCard approval={a} onRespond={(d) => respond(a, d)} />
            </View>
          ))}
          <Composer
            disabled={!loaded || status !== "open" || thread?.status === "archived"}
            working={working}
            onSend={send}
            onInterrupt={interrupt}
            placeholder={working ? "Queue a message" : thread?.permission_mode === "full-access" ? "Message · Full access" : "Message"}
          />
        </Animated.View>
      </KeyboardStickyView>
    </Screen>
  );
}

function entryKey(e: TranscriptEntry, i: number): string {
  switch (e.role) {
    case "user":
      return `user:${e.id}`;
    case "assistant":
      return `assistant:${e.id}#${e.segment ?? 0}`;
    case "tool_call":
      return `tool:${e.call.id}`;
    case "runtime_task":
      return `task:${e.task.id}`;
    case "approval":
      return `approval:${e.approval.id}`;
    case "notice":
      return `notice:${e.seq}`;
    case "reverted":
      return `reverted:${e.seq}`;
    case "turn_summary":
      return `summary:${e.turn_id}`;
    default:
      return `row:${i}`;
  }
}

const EntryView = React.memo(function EntryView({ entry }: { entry: TranscriptEntry }) {
  const th = useTheme();
  switch (entry.role) {
    case "user": {
      const text = entry.message.parts
        .map((p) => (p.type === "text" ? p.text : p.type === "file_mention" ? `@${p.path}` : p.type === "image" ? "[image]" : `[${p.name}]`))
        .join("");
      return (
        <Animated.View entering={FadeIn.duration(180)} style={[styles.block, styles.userWrap]}>
          <View style={[styles.userCard, { backgroundColor: th.bubble }]}>
            <Txt variant="transcript" selectable>
              {text}
            </Txt>
          </View>
        </Animated.View>
      );
    }
    case "assistant":
      if (!entry.text) return null;
      return (
        <View style={styles.block}>
          <Markdown text={entry.text} />
        </View>
      );
    case "tool_call":
      return (
        <View style={styles.blockTight}>
          <ToolRow entry={entry} />
        </View>
      );
    case "runtime_task": {
      const active = ["pending", "running", "waiting", "stopping"].includes(entry.task.status);
      const noun = entry.task.kind === "agent" ? "Agent" : entry.task.kind === "process" ? "Process" : "Monitor";
      const st = entry.task.status === "pending" ? "starting" : entry.task.status;
      return (
        <View style={styles.blockTight}>
          <Txt variant="footnote" tone="tertiary" color={entry.task.status === "failed" ? th.failed : active ? th.running : undefined} numberOfLines={1}>
            {noun} {st} · {entry.task.title}
          </Txt>
        </View>
      );
    }
    case "approval":
      if (!entry.decision) return null;
      return (
        <View style={styles.blockTight}>
          <Txt variant="footnote" tone="tertiary" numberOfLines={1}>
            {entry.decision.decision === "deny" ? "Declined" : "Approved"} · {entry.approval.summary || entry.approval.tool_name}
          </Txt>
        </View>
      );
    case "notice":
      return (
        <View style={styles.blockTight}>
          <Txt variant="footnote" tone="tertiary" color={entry.level === "error" ? th.failed : entry.level === "warning" ? th.waiting : undefined}>
            {entry.text}
          </Txt>
        </View>
      );
    case "reverted":
      return (
        <View style={styles.blockTight}>
          <Txt variant="footnote" tone="tertiary">
            Reverted to before this turn
          </Txt>
        </View>
      );
    case "turn_summary":
      return (
        <View style={[styles.block, styles.summary]}>
          <View style={[styles.summaryRule, { backgroundColor: th.hairline }]} />
          <Txt variant="caption" tone="tertiary" color={entry.error ? th.failed : undefined} numberOfLines={2} style={{ fontVariant: ["tabular-nums"] }}>
            {summaryText(entry)}
          </Txt>
          <View style={[styles.summaryRule, { backgroundColor: th.hairline }]} />
        </View>
      );
    default:
      return null;
  }
});

function summaryText(e: Extract<TranscriptEntry, { role: "turn_summary" }>): string {
  if (e.error) return `Failed · ${e.error}`;
  const parts: string[] = [];
  switch (e.stop_reason) {
    case "completed":
      parts.push("Done");
      break;
    case "interrupted":
      parts.push("Stopped");
      break;
    case "max_turns":
      parts.push("Stopped at the turn limit");
      break;
    case "error":
      parts.push("Failed");
      break;
  }
  if (e.duration_ms > 0) parts.push(formatDuration(e.duration_ms));
  const tokens = e.usage.input_tokens + e.usage.output_tokens;
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  if (e.cost_usd != null) parts.push(`$${e.cost_usd.toFixed(2)}`);
  return parts.join(" · ");
}

const styles = StyleSheet.create({
  block: { paddingVertical: space.sm },
  blockTight: { paddingVertical: 2 },
  userWrap: { alignItems: "flex-end" },
  userCard: { maxWidth: "84%", borderRadius: radius.xl, borderBottomRightRadius: radius.sm, paddingHorizontal: space.lg, paddingVertical: space.sm + 2 },
  summary: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md },
  summaryRule: { flex: 1, height: StyleSheet.hairlineWidth },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  dockInner: { gap: space.sm, paddingTop: space.sm },
  approval: { marginHorizontal: space.md },
});
