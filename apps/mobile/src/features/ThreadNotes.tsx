import { useState } from "react";
import { View } from "react-native";
import type { ThreadNotes as Notes } from "../state/protocol";
import type { ThreadState } from "../state/transcript";
import { errorText, rpc, useApp, useThreadValue } from "../state/runtime";
import { Button, ErrorBanner, Field, T } from "../ui/primitives";

const empty: Notes = { text: "", revision: 0 };
const selectNotes = (state: ThreadState) => state.notes ?? empty;
const selectLoaded = (state: ThreadState) => state.loaded;
// Preserve unsaved edits while navigating between a conversation and its notes.
const drafts = new Map<string, Notes>();

export function ThreadNotes({ threadId }: { threadId: string }) {
  const app = useApp();
  const remote = useThreadValue(threadId, selectNotes);
  const loaded = useThreadValue(threadId, selectLoaded);
  const key = `${app.activeId}:${threadId}`;
  const [draft, setDraft] = useState<Notes | undefined>(() => drafts.get(key));
  const [result, setResult] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = result.revision > remote.revision ? result : remote;
  const text = draft?.text ?? saved.text;
  const dirty = text !== saved.text;
  const conflict = dirty && draft !== undefined && draft.revision !== saved.revision;
  function edit(text: string) {
    const next = { text, revision: dirty ? draft?.revision ?? saved.revision : saved.revision };
    drafts.set(key, next);
    setDraft(next);
  }
  function reload() {
    drafts.delete(key);
    setDraft(undefined);
    setError("");
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const notes = await rpc("threads.notes.set", {
        thread_id: threadId, text, expected_revision: draft?.revision ?? saved.revision,
      });
      setResult(notes);
      reload();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <View style={{ gap: 16 }}>
    <T variant="caption" tone="secondary">Ideas, reminders, and things to do in this conversation. Saved notes sync with your computer.</T>
    <Field label="Thread notes" hideLabel multiline textAlignVertical="top" value={text}
      editable={loaded && !busy} onChangeText={edit} placeholder="Write a note…" style={{ minHeight: 260, maxHeight: 440 }} />
    <T variant="caption" tone="secondary">{!loaded ? "Loading notes…" : busy ? "Saving…" : dirty ? "Unsaved notes" : "Saved notes"}</T>
    <ErrorBanner error={error || (conflict ? "Notes changed on another device. Copy your edits before reloading." : "")} />
    <Button busy={busy} disabled={app.status !== "open" || !loaded || !dirty || conflict} onPress={() => void save()}>Save notes</Button>
    {draft && <Button secondary disabled={busy} onPress={reload}>Reload saved notes</Button>}
  </View>;
}
