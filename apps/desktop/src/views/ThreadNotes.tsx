import { useState } from "react"
import { Button } from "@/components/kit/button"
import { Textarea } from "@/components/kit/textarea"
import { useLocalStorage } from "@/lib/hooks"
import type { ThreadId, ThreadNotes as Notes } from "@/protocol"
import { activeRuntime, errorText } from "@/state/rpc"
import { useStore } from "@/state/store"

const EMPTY_NOTES: Notes = { text: "", revision: 0 }

export function ThreadNotes({ threadId }: { threadId: ThreadId }) {
  const saved = useStore((s) => s.transcripts[threadId]?.notes ?? EMPTY_NOTES)
  const loaded = useStore((s) => !!s.transcripts[threadId]?.loaded)
  const connected = useStore((s) => s.connection.state === "open")
  const environmentId = useStore((s) => s.environmentId)
  const [draft, setDraft] = useLocalStorage<Notes | null>(`kybern.notes.draft:${environmentId}:${threadId}`, null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const text = draft?.text ?? saved.text
  const dirty = text !== saved.text
  const conflict = dirty && draft !== null && draft.revision !== saved.revision

  async function save() {
    const owner = useStore
    setBusy(true)
    setError("")
    try {
      const client = activeRuntime().rpc()
      const notes = await client.call("threads.notes.set", { thread_id: threadId, text, expected_revision: draft?.revision ?? saved.revision })
      owner.getState().updateTranscript(threadId, (state) => ({ ...state, notes: (state.notes?.revision ?? 0) > notes.revision ? state.notes : notes }))
      setDraft(null)
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  return <div className="flex flex-col gap-2 px-2 pb-2">
    <Textarea aria-label="Thread notes" size="sm" value={text} disabled={!loaded || busy}
      placeholder="Ideas, reminders, things to do…"
      className="[&_textarea]:min-h-28 [&_textarea]:max-h-64 [&_textarea]:overflow-y-auto"
      onChange={(event) => setDraft({ text: event.target.value, revision: dirty ? draft?.revision ?? saved.revision : saved.revision })} />
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground" role="status">{busy ? "Saving…" : dirty ? "Unsaved notes" : "Saved notes"}</span>
      <Button size="chip" variant="subtle" disabled={!connected || !loaded || busy || !dirty || conflict} onClick={() => void save()}>Save notes</Button>
    </div>
    {(conflict || error) && <p role="alert" className="text-xs text-destructive">{error || "Notes changed on another device. Copy your edits before reloading."}</p>}
    {draft && <Button size="chip" variant="ghost" disabled={busy} onClick={() => { setDraft(null); setError("") }}>Reload saved notes</Button>}
  </div>
}
