import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnection } from "@/connection/ConnectionContext";
import type { ApprovalDecision, ApprovalRequest, TranscriptEntry } from "@/protocol";
import { applyEvent, emptyThreadState, removeApproval, seedFromGet, type ThreadState } from "@/state/transcript";
import { ApprovalCard } from "@/ui/ApprovalCard";
import { Composer } from "@/ui/Composer";
import { Markdown } from "@/ui/Markdown";
import { Caption, EmptyState, Screen } from "@/ui/Screen";
import { statusColor, statusLabel } from "@/ui/StatusDot";
import { ToolRow } from "@/ui/ToolRow";
import { radius, space, type as t, useTheme } from "@/ui/theme";

type Row =
  | { key: string; kind: "entry"; entry: TranscriptEntry }
  | { key: string; kind: "approval"; approval: ApprovalRequest };

export default function ThreadScreen() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client, status } = useConnection();
  const [state, setState] = useState<ThreadState>(emptyThreadState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<FlatList<Row>>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Seed from threads.get, then subscribe from the seed's last_seq so nothing
  // between the two calls is lost. Reconnects replay from the last delivered
  // seq inside the client; a lag notice does the same.
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
            // After a resubscribe the replay covers the gap. Refresh pending
            // approvals too, in case one was resolved elsewhere while offline.
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

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = state.entries.map((entry, i) => ({ key: entryKey(entry, i), kind: "entry", entry }));
    for (const a of state.pendingApprovals) out.push({ key: `approval:${a.id}`, kind: "approval", approval: a });
    return out;
  }, [state.entries, state.pendingApprovals]);

  const respond = useCallback(
    async (approval: ApprovalRequest, decision: ApprovalDecision) => {
      if (!client) throw new Error("Not connected");
      await client.call("approvals.respond", { approval_id: approval.id, ...decision });
      setState((s) => removeApproval(s, approval.id));
    },
    [client],
  );

  const send = useCallback(
    async (text: string) => {
      if (!client || !id) throw new Error("Not connected");
      await client.call("threads.send", { thread_id: id, message: { parts: [{ type: "text", text }] } });
    },
    [client, id],
  );

  const interrupt = useCallback(async () => {
    if (!client || !id) return;
    await client.call("threads.interrupt", { thread_id: id }).catch(() => {});
  }, [client, id]);

  const thread = state.thread;
  const label = thread ? statusLabel(thread.status) : null;
  const working = thread?.status === "running";

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: thread?.title || "Thread",
          headerRight: label
            ? () => (
                <Text style={[t.caption, { color: thread ? (statusColor(thread.status, th) ?? th.textSecondary) : th.textSecondary }]}>{label}</Text>
              )
            : undefined,
        }}
      />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top + 44}>
        {status !== "open" ? (
          <View style={[styles.banner, { backgroundColor: th.surface }]}>
            <Caption>{status === "reconnecting" ? "Reconnecting… you can keep reading" : status === "connecting" ? "Connecting…" : "Disconnected"}</Caption>
          </View>
        ) : null}
        {loadError ? (
          <View style={[styles.banner, { backgroundColor: th.surface }]}>
            <Caption color={th.failed}>{loadError}</Caption>
          </View>
        ) : null}
        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={({ item }) => <RowView row={item} onRespond={respond} />}
          contentContainerStyle={styles.list}
          keyboardDismissMode="interactive"
          onContentSizeChange={() => {
            if (rows.length) listRef.current?.scrollToEnd({ animated: false });
          }}
          ListEmptyComponent={loaded ? <EmptyState title="Empty thread" hint="Send a message to start." /> : null}
          ListFooterComponent={<View style={{ height: space.lg }} />}
        />
        <View style={{ paddingBottom: insets.bottom }}>
          <Composer
            disabled={!loaded || status !== "open" || thread?.status === "archived"}
            working={working}
            onSend={send}
            onInterrupt={interrupt}
            placeholder={working ? "Queue a message" : "Message"}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function entryKey(e: TranscriptEntry, i: number): string {
  switch (e.role) {
    case "user":
      return `${e.role}:${e.id}`;
    case "assistant":
      return `assistant:${e.id}#${e.segment ?? 0}`;
    case "tool_call":
      return `tool:${e.call.id}`;
    case "runtime_task":
      return `task:${e.task.id}`;
    case "approval":
      return `approval-history:${e.approval.id}`;
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

const RowView = React.memo(function RowView({
  row,
  onRespond,
}: {
  row: Row;
  onRespond: (a: ApprovalRequest, d: ApprovalDecision) => Promise<void>;
}) {
  const th = useTheme();
  switch (row.kind) {
    case "approval":
      return (
        <View style={styles.block}>
          <ApprovalCard approval={row.approval} onRespond={(d) => onRespond(row.approval, d)} />
        </View>
      );
    case "entry":
      return <EntryView entry={row.entry} />;
    default:
      return null;
  }
});

function EntryView({ entry }: { entry: TranscriptEntry }) {
  const th = useTheme();
  switch (entry.role) {
    case "user": {
      const text = entry.message.parts
        .map((p) => (p.type === "text" ? p.text : p.type === "file_mention" ? `@${p.path}` : p.type === "image" ? "[image]" : `[${p.name}]`))
        .join("");
      return (
        <View style={[styles.block, styles.userWrap]}>
          <View style={[styles.userCard, { backgroundColor: th.surface }]}>
            <Text style={[t.transcript, { color: th.text }]} selectable>
              {text}
            </Text>
          </View>
        </View>
      );
    }
    case "assistant":
      if (!entry.text && !entry.complete) {
        return (
          <View style={styles.block}>
            <Caption color={th.textTertiary}>Thinking…</Caption>
          </View>
        );
      }
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
      const status = entry.task.status === "pending" ? "starting" : entry.task.status === "running" ? "running" : entry.task.status;
      return (
        <View style={styles.blockTight}>
          <Caption color={entry.task.status === "failed" ? th.failed : active ? th.waiting : th.textTertiary}>
            {noun} {status} · {entry.task.title}
          </Caption>
        </View>
      );
    }
    case "approval":
      if (!entry.decision) return null;
      return (
        <View style={styles.blockTight}>
          <Caption color={th.textTertiary}>
            {entry.decision.decision === "deny" ? "Declined" : "Approved"} · {entry.approval.summary || entry.approval.tool_name}
          </Caption>
        </View>
      );
    case "notice":
      return (
        <View style={styles.blockTight}>
          <Caption color={entry.level === "error" ? th.failed : entry.level === "warning" ? th.waiting : th.textTertiary}>{entry.text}</Caption>
        </View>
      );
    case "reverted":
      return (
        <View style={styles.blockTight}>
          <Caption color={th.textTertiary}>Reverted to before this turn</Caption>
        </View>
      );
    case "turn_summary":
      return (
        <View style={styles.block}>
          <Caption color={entry.error ? th.failed : th.textTertiary}>{summaryText(entry)}</Caption>
        </View>
      );
    default:
      return null;
  }
}

function summaryText(e: Extract<TranscriptEntry, { role: "turn_summary" }>): string {
  if (e.error) return `Failed: ${e.error}`;
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
  if (tokens > 0) parts.push(`${tokens.toLocaleString()} tokens`);
  if (e.cost_usd != null) parts.push(`$${e.cost_usd.toFixed(2)}`);
  return parts.join(" · ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  list: { paddingVertical: space.md },
  block: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  blockTight: { paddingHorizontal: space.lg, paddingVertical: 2 },
  userWrap: { alignItems: "flex-end" },
  userCard: { maxWidth: "88%", borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm },
});
