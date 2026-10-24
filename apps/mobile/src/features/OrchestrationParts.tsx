import { router } from "expo-router";
import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import {
  delegationState,
  filesLabel,
  messageSenderName,
  purposeLabel,
  resultNeedsClamp,
  resultPreview,
  shortBranch,
} from "../../../../packages/kybern-client/src/delegations";
import type { AgentResultItem, ThreadMessagePart } from "../state/protocol";
import { count } from "../state/format";
import { Icon, T, Tap } from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { StatusGlyph } from "../ui/TaskGlyphs";
import { radius, space, useTheme } from "../ui/theme";

/** Conversation cards lift off the page with the `card` fill and a hairline (ux-thread H12). */
function Card({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: colors.card,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        paddingHorizontal: space.md,
        paddingVertical: padded ? space.md : space.xs,
        gap: space.sm,
      }}
    >
      {children}
    </View>
  );
}

/** A message from another thread (or Kybern): sender and purpose, then the body. */
export function ThreadMessageCard({ part }: { part: ThreadMessagePart }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const long = resultNeedsClamp(part.body);
  const sender = messageSenderName(part);
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon name="text.bubble" size={14} color={colors.secondary} />
        <T variant="footnote" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
          {`${purposeLabel(part.purpose)} from ${sender}`}
        </T>
        {!!part.from_thread_id && (
          <Tap
            label={`Open ${sender}`}
            onPress={() => router.push({ pathname: "/thread/[id]", params: { id: part.from_thread_id! } })}
            style={{ alignItems: "center", justifyContent: "center" }}
          >
            <T variant="footnote" tone="accent">
              Open
            </T>
          </Tap>
        )}
      </View>
      <T selectable numberOfLines={long && !expanded ? 8 : undefined}>
        {part.body}
      </T>
      {long && (
        <Tap
          label={expanded ? "Show less" : "Show the full message"}
          onPress={() => setExpanded((value) => !value)}
          style={{ alignSelf: "flex-start", minHeight: 36, justifyContent: "center" }}
        >
          <T variant="footnote" tone="accent">
            {expanded ? "Show less" : "Show more"}
          </T>
        </Tap>
      )}
    </Card>
  );
}

function ResultRow({ item, first }: { item: AgentResultItem; first: boolean }) {
  const { colors } = useTheme();
  const state = delegationState(item.status);
  const files = item.files_touched?.length ?? item.diffstat?.files ?? 0;
  const where = item.workspace === "worktree" && item.branch ? shortBranch(item.branch) : files > 0 ? `${filesLabel(files)} touched` : "";
  const preview = resultPreview(item) || (item.status === "running" ? "Still working" : "No result text");
  return (
    <Tap
      label={`Open ${item.title}, ${state.word}`}
      onPress={() => router.push({ pathname: "/thread/[id]", params: { id: item.thread_id } })}
      feedback="highlight"
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space.md,
        paddingVertical: space.sm + 2,
        marginHorizontal: -space.md,
        paddingHorizontal: space.md,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderColor: colors.line,
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <ProviderMark kind={item.provider} size={16} />
      </View>
      <View style={{ flex: 1, gap: space["2xs"] }}>
        <T variant="subhead" style={{ fontWeight: "500" }} numberOfLines={1}>
          {item.title}
        </T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
          <StatusGlyph phase={state.phase} size={12} />
          <T variant="footnote" tone="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
            {[state.word, where].filter(Boolean).join(" · ")}
          </T>
        </View>
        <T variant="footnote" tone="secondary" numberOfLines={2}>
          {preview}
        </T>
      </View>
      <View style={{ paddingTop: 4 }}>
        <Icon name="chevron.right" size={12} color={colors.muted} />
      </View>
    </Tap>
  );
}

/** What the delegated agents reported back, one row each. */
export function AgentResultsList({ items }: { items: AgentResultItem[] }) {
  const { colors } = useTheme();
  return (
    <Card padded={false}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.sm }}>
        <Icon name="person.2" size={14} color={colors.secondary} />
        <T variant="footnote" tone="secondary">
          {items.length === 1 ? "Agent result" : count(items.length, "agent result")}
        </T>
      </View>
      <View>
        {items.map((item, index) => (
          <ResultRow key={item.task_id} item={item} first={index === 0} />
        ))}
      </View>
    </Card>
  );
}
