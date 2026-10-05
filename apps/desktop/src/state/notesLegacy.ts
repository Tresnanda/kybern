// The Environment panel's old notes box kept unsaved text in localStorage as
// `kybern.notes.draft:<environment>:<thread>` = { text, revision }. The editor that
// replaced it keeps drafts in its own format; this carries an unsaved one across
// once, so an edit made just before updating is still there afterwards.
import type { ThreadId } from "@/protocol"
import { draftKey } from "./noteSession"
import { noteClient, useNotes } from "./notes"

const legacyKey = (environmentId: string, threadId: ThreadId) => `kybern.notes.draft:${environmentId}:${threadId}`

export async function migrateLegacyThreadDraft(environmentId: string, threadId: ThreadId): Promise<void> {
  const key = legacyKey(environmentId, threadId)
  let legacy: { text: string } | null = null
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (raw === null || raw === undefined) return
    const value = JSON.parse(raw)
    if (value && typeof value.text === "string") legacy = { text: value.text }
  } catch {
    /* An unreadable draft is not worth keeping. */
  }
  if (!legacy) {
    removeKey(key)
    return
  }
  try {
    const { note } = await noteClient("env").call("notes.get", { thread_id: threadId })
    const saved = note?.body ?? ""
    const ownerKey = useNotes.getState().env.ownerKey ?? environmentId
    const target = draftKey(ownerKey, { kind: "thread", threadId })
    // Only unsaved text is worth carrying over, and never over a newer draft.
    if (legacy.text.trimEnd() !== saved.trimEnd() && globalThis.localStorage?.getItem(target) === null) {
      globalThis.localStorage?.setItem(target, JSON.stringify({ title: "", body: legacy.text, baseRevision: note?.revision ?? 0, at: Date.now() }))
    }
    removeKey(key)
  } catch {
    /* Not connected yet: keep the old draft and try again next time. */
  }
}

function removeKey(key: string) {
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    /* Nothing to remove. */
  }
}
