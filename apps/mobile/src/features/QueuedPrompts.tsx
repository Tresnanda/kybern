// Follow-ups queued behind a running turn. The bottom bar shows one capsule ("2 queued");
// the list, with edit and remove, lives in the Queued messages sheet (ux-thread S2: no
// lists expanding inside the floating chrome).
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { promptText, replacePromptText } from "../../../../packages/kybern-client/src/prompts";
import type { QueuedMessage } from "../state/protocol";
import { orchestrationLabel } from "../state/orchestration";
import { errorText, rpc, useApp } from "../state/runtime";
import { showToast } from "../ui/Toast";
import { InsetGroup, ListRow } from "../ui/List";
import { Button, Field, Icon, T, Tap } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";

/** "2 queued ›" on the bottom bar: opens the Queued messages sheet. */
export function QueuedCapsule({ threadId, count }: { threadId: string; count: number }) {
  const { colors } = useTheme();
  return (
    <Tap
      label={`${count} queued ${count === 1 ? "message" : "messages"}. Open queue`}
      onPress={() => router.push({ pathname: "/queued", params: { threadId } })}
      hitSlop={{ top: 4, bottom: 4 }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        height: 36,
        minHeight: 36,
        paddingStart: space.md,
        paddingEnd: space.sm,
        borderRadius: radius.full,
        backgroundColor: colors.raised,
      }}
    >
      <T variant="label" style={{ fontVariant: ["tabular-nums"] }}>
        {count} queued
      </T>
      <Icon name="chevron.right" size={12} color={colors.muted} />
    </Tap>
  );
}

/** The queue as inset rows: tap to edit a prompt, Remove to drop it. */
export function QueuedPrompts({ items }: { items: QueuedMessage[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const editingItem = items.find((item) => item.id === editing);
  return (
    <View style={{ gap: space.lg }}>
      <InsetGroup>
        {items.map((item, index) => {
          const relayed = orchestrationLabel(item.message);
          const text = promptText(item.message) || relayed || "Attached context";
          return (
            <ListRow
              key={item.id}
              title={text}
              titleLines={3}
              leading={<T variant="footnote" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>{index + 1}</T>}
              subtitle={relayed ? "Agent message" : undefined}
              onPress={relayed ? undefined : () => setEditing(item.id)}
              swipe={{ trailing: [{ title: "Remove", icon: "trash", tone: "negative", full: true, onPress: () => void remove(item) }] }}
              menu={[
                ...(relayed ? [] : [{ title: "Edit", icon: "pencil" as const, onPress: () => setEditing(item.id) }]),
                { title: "Remove from queue", icon: "trash" as const, destructive: true, onPress: () => void remove(item) },
              ]}
            />
          );
        })}
      </InsetGroup>
      {editingItem && <QueuedEditor key={editingItem.id} item={editingItem} onDone={() => setEditing(null)} />}
    </View>
  );
}

async function remove(item: QueuedMessage) {
  try {
    await rpc("queue.remove", { thread_id: item.thread_id, id: item.id });
    showToast("Removed from the queue");
  } catch (e) {
    showToast(errorText(e));
  }
}

function QueuedEditor({ item, onDone }: { item: QueuedMessage; onDone: () => void }) {
  const app = useApp();
  const [text, setText] = useState(promptText(item.message));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attached = item.message.parts.some((part) => part.type !== "text");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await rpc("queue.update", { ...item, message: replacePromptText(item.message, text) });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: space.md }}>
      <Field label="Edit queued message" multiline autoFocus value={text} onChangeText={setText} editable={!busy} error={error} />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.lg, alignItems: "center" }}>
        <Button role="plain" size="medium" disabled={busy} onPress={onDone}>
          Cancel
        </Button>
        <Button
          role="tinted"
          size="medium"
          busy={busy}
          disabled={app.status !== "open" || (!text.trim() && !attached)}
          onPress={() => void save()}
        >
          Save
        </Button>
      </View>
    </View>
  );
}
