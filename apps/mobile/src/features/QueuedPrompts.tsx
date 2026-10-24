import { useState } from "react";
import { ScrollView, View } from "react-native";
import { promptText, replacePromptText } from "../../../../packages/kybern-client/src/prompts";
import type { QueuedMessage } from "../state/protocol";
import { orchestrationLabel } from "../state/orchestration";
import { errorText, rpc, useApp } from "../state/runtime";
import { ErrorBanner, Field, Icon, IconButton, styles, T, Tap } from "../ui/primitives";

export function QueuedPrompts({ items }: { items: QueuedMessage[] }) {
  return <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: 20 }}>
    <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
      <T variant="footnote" tone="secondary">Queued · {items.length}</T>
      {items.map(item => <QueuedPrompt key={item.id} item={item} />)}
    </ScrollView>
  </View>;
}
function QueuedPrompt({ item }: { item: QueuedMessage }) {
  const app = useApp();
  const connected = app.status === "open";
  const relayed = orchestrationLabel(item.message);
  const [showBody, setShowBody] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const contextCount = item.message.parts.filter(part => part.type !== "text").length;
  async function run(save: boolean) {
    setBusy(true);
    setError("");
    try {
      if (save) {
        await rpc("queue.update", { ...item, message: replacePromptText(item.message, edit ?? promptText(item.message)) });
        setEdit(null);
      } else await rpc("queue.remove", { thread_id: item.thread_id, id: item.id });
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <View style={{ paddingTop: 6 }}>
    {edit !== null && <Field label="Edit queued prompt" hideLabel multiline value={edit} onChangeText={setEdit} editable={!busy} />}
    <View style={styles.spread}>
      {edit === null ? <>
        <Tap static label="Show queued prompt" expanded={showBody} onPress={() => setShowBody(value => !value)} style={{ flex: 1, minHeight: 48, justifyContent: "center" }}>
          <View style={[styles.line, { gap: 8 }]}><T variant="footnote" numberOfLines={showBody ? undefined : 2} style={{ flex: 1 }}>{promptText(item.message) || relayed || "Attached context"}</T><Icon name={showBody ? "chevron.up" : "chevron.down"} size={12} /></View>
        </Tap>
        {!relayed && <IconButton name="pencil" label="Edit queued prompt" disabled={!connected || busy} onPress={() => setEdit(promptText(item.message))} />}
      </> : <View style={styles.line}>
        <Tap label="Save queued prompt" disabled={!connected || busy || (!edit.trim() && !contextCount)} onPress={() => void run(true)} style={{ minHeight: 44, padding: 12 }}><T variant="footnote">Save</T></Tap>
        <Tap label="Cancel edit" disabled={busy} onPress={() => setEdit(null)} style={{ minHeight: 44, padding: 12 }}><T variant="footnote">Cancel</T></Tap>
      </View>}
      <IconButton name="xmark" label="Remove queued message" disabled={!connected || busy} onPress={() => void run(false)} />
    </View>
    <ErrorBanner error={error} />
  </View>;
}
