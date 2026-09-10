import { useState } from "react";
import { ScrollView, View } from "react-native";
import { promptText, replacePromptText } from "../../../../packages/kybern-client/src/prompts";
import type { QueuedMessage } from "../state/protocol";
import { errorText, rpc, useApp } from "../state/runtime";
import { ErrorBanner, Field, IconButton, styles, T, Tap } from "../ui/primitives";

export function QueuedPrompts({ items }: { items: QueuedMessage[] }) {
  return <ScrollView style={{ maxHeight: 200, width: "100%", maxWidth: 760, alignSelf: "center" }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
    <T variant="caption" tone="secondary">Queued · {items.length}</T>
    {items.map(item => <QueuedPrompt key={item.id} item={item} />)}
  </ScrollView>;
}
function QueuedPrompt({ item }: { item: QueuedMessage }) {
  const connected = useApp().status === "open";
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
        <T variant="caption" tone="secondary" numberOfLines={2} style={{ flex: 1 }}>{promptText(item.message) || "Attached context"}{contextCount > 0 ? ` · ${contextCount} attached` : ""}</T>
        <IconButton name="pencil" label="Edit queued prompt" disabled={!connected || busy} onPress={() => setEdit(promptText(item.message))} />
      </> : <View style={styles.line}>
        <Tap label="Save queued prompt" disabled={!connected || busy || (!edit.trim() && !contextCount)} onPress={() => void run(true)} style={{ minHeight: 44, padding: 12 }}><T variant="caption">Save</T></Tap>
        <Tap label="Cancel edit" disabled={busy} onPress={() => setEdit(null)} style={{ minHeight: 44, padding: 12 }}><T variant="caption">Cancel</T></Tap>
      </View>}
      <IconButton name="xmark" label="Remove queued message" disabled={!connected || busy} onPress={() => void run(false)} />
    </View>
    <ErrorBanner error={error} />
  </View>;
}
