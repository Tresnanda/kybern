import { collaborationPreview } from "../../../../packages/kybern-client/src/collaboration";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { promptText, replacePromptText } from "../../../../packages/kybern-client/src/prompts";
import type { QueuedMessage } from "../state/protocol";
import { errorText, rpc, useApp } from "../state/runtime";
import { ErrorBanner, Field, Icon, IconButton, styles, T, Tap } from "../ui/primitives";

export function QueuedPrompts({ items }: { items: QueuedMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const updates = items.filter(item => collaborationPreview(promptText(item.message)));
  const prompts = items.filter(item => !collaborationPreview(promptText(item.message)));
  return <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: 20 }}>
    {updates.length > 0 && <Tap static expanded={expanded} label={`${expanded ? "Hide" : "Show"} ${updates.length} queued agent updates`}
      onPress={() => setExpanded(value => !value)} style={[styles.line, { minHeight: 48, gap: 8 }]}>
      <Icon name="person.2" size={16} />
      <T variant="caption" style={{ flex: 1 }}>{updates.length} agent {updates.length === 1 ? "update" : "updates"} waiting</T>
      <Icon name={expanded ? "chevron.up" : "chevron.down"} size={12} />
    </Tap>}
    {(prompts.length > 0 || expanded) && <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
      {prompts.length > 0 && <T variant="caption" tone="secondary">Queued · {prompts.length}</T>}
      {items.filter(item => expanded || !collaborationPreview(promptText(item.message))).map(item => <QueuedPrompt key={item.id} item={item} />)}
    </ScrollView>}
  </View>;
}
function QueuedPrompt({ item }: { item: QueuedMessage }) {
  const app = useApp();
  const connected = app.status === "open";
  const preview = collaborationPreview(promptText(item.message));
  const sender = preview?.senderId ? app.threads.find(thread => thread.id === preview.senderId)?.title || "Helper" : "You";
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
        <Tap static label={preview ? `${preview.purpose} from ${sender}. ${showBody ? "Hide" : "Show"} message` : "Show queued prompt"} expanded={showBody} onPress={() => setShowBody(value => !value)} style={{ flex: 1, minHeight: 48, justifyContent: "center" }}>
          <View style={[styles.line, { gap: 8 }]}><T variant="caption" numberOfLines={showBody ? undefined : 2} style={{ flex: 1 }}>{preview ? `${preview.purpose} · ${sender}` : promptText(item.message) || "Attached context"}</T><Icon name={showBody ? "chevron.up" : "chevron.down"} size={12} /></View>
          {preview && <T variant="caption" tone="secondary" numberOfLines={showBody ? undefined : 2}>{preview.body}</T>}
        </Tap>
        {!preview && <IconButton name="pencil" label="Edit queued prompt" disabled={!connected || busy} onPress={() => setEdit(promptText(item.message))} />}
      </> : <View style={styles.line}>
        <Tap label="Save queued prompt" disabled={!connected || busy || (!edit.trim() && !contextCount)} onPress={() => void run(true)} style={{ minHeight: 44, padding: 12 }}><T variant="caption">Save</T></Tap>
        <Tap label="Cancel edit" disabled={busy} onPress={() => setEdit(null)} style={{ minHeight: 44, padding: 12 }}><T variant="caption">Cancel</T></Tap>
      </View>}
      <IconButton name="xmark" label="Remove queued message" disabled={!connected || busy} onPress={() => void run(false)} />
    </View>
    <ErrorBanner error={error} />
  </View>;
}
