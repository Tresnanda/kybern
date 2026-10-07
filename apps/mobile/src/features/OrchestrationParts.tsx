import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import type { AgentResultItem, ThreadMessagePart } from "../state/protocol";
import {
  delegationStatusWord,
  resultLocation,
  resultSummary,
  threadMessageHeading,
} from "../state/orchestration";
import { Icon, T, Tap, styles } from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { useTheme } from "../ui/theme";

const LONG = 420;

/** A message from another thread (or Kybern): sender and purpose, then the body. */
export function ThreadMessageCard({ part }: { part: ThreadMessagePart }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const long = part.body.length > LONG;
  return (
    <View
      style={{
        borderRadius: 14,
        backgroundColor: colors.surface,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 6,
      }}
    >
      <View style={[styles.line, { gap: 8 }]}>
        <Icon name="text.bubble" size={14} color={colors.secondary} />
        <T variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
          {threadMessageHeading(part)}
        </T>
      </View>
      <T selectable numberOfLines={long && !expanded ? 8 : undefined}>
        {part.body}
      </T>
      {long && (
        <Tap
          label={expanded ? "Show less" : "Show full message"}
          onPress={() => setExpanded((value) => !value)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <T variant="caption" tone="secondary">
            {expanded ? "Show less" : "Show more"}
          </T>
        </Tap>
      )}
    </View>
  );
}

function ResultRow({ item }: { item: AgentResultItem }) {
  const { colors } = useTheme();
  const location = resultLocation(item);
  const status = delegationStatusWord(item.status);
  return (
    <Tap
      label={`Open ${item.title}, ${status}`}
      onPress={() =>
        router.push({ pathname: "/thread/[id]", params: { id: item.thread_id } })
      }
      style={[styles.line, { minHeight: 48, gap: 10, paddingVertical: 8 }]}
    >
      <ProviderMark kind={item.provider} size={15} />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="label" numberOfLines={1}>
          {item.title}
        </T>
        <T variant="caption" tone="secondary" numberOfLines={2}>
          {status} · {resultSummary(item)}
        </T>
        {!!location && (
          <T variant="caption" tone="muted" numberOfLines={1}>
            {location}
          </T>
        )}
      </View>
      <Icon name="chevron.right" size={11} color={colors.muted} />
    </Tap>
  );
}

/** What the delegated agents reported back, one readable row each. */
export function AgentResultsList({ items }: { items: AgentResultItem[] }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        borderRadius: 14,
        backgroundColor: colors.surface,
        paddingHorizontal: 12,
        paddingVertical: 6,
      }}
    >
      <View style={[styles.line, { gap: 8, paddingTop: 6 }]}>
        <Icon name="person.2" size={14} color={colors.secondary} />
        <T variant="caption" tone="secondary">
          {items.length === 1 ? "Agent result" : `${items.length} agent results`}
        </T>
      </View>
      {items.map((item) => (
        <ResultRow key={item.task_id} item={item} />
      ))}
    </View>
  );
}
