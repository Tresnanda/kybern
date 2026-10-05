// Thumbnail content for the Notes gallery. The list only carries summaries, so a
// card asks for its note's body when it is on screen; the body is read once per
// revision, parsed into a small MiniDoc and dropped. What is kept is bounded (an
// LRU of parsed thumbnails, never bodies), requests run a few at a time, and a
// card that scrolls away before its turn is skipped. Saving a note in the editor
// refreshes its thumbnail without another request.
import { useCallback, useSyncExternalStore } from "react"

import { reloadOnHotUpdate } from "@/lib/hot"
import type { Note, NoteSummary } from "@/protocol"
import { miniMarkdown, type MiniDoc } from "./miniMarkdown"
import { locateNote, noteBodyListeners, noteClient } from "./notes"

/** Parsed thumbnails kept; a few screens of cards. Each is a few hundred bytes. */
const CACHE_LIMIT = 240
/** Bodies read at once. */
const CONCURRENCY = 3

const EMPTY: MiniDoc = { blocks: [], lines: 0 }

const cache = new Map<string, MiniDoc>()
/** The newest thumbnail of each note, shown while a newer revision is read. */
const latest = new Map<string, MiniDoc>()
const watchers = new Map<string, Set<() => void>>()
const queued: { key: string; id: string }[] = []
const pending = new Set<string>()
/** Revisions that could not be read; tried again only when the note changes. */
const failed = new Set<string>()
let running = 0

const keyOf = (note: Pick<NoteSummary, "id" | "revision">) => `${note.id}:${note.revision}`

function remember(key: string, doc: MiniDoc) {
  cache.delete(key)
  cache.set(key, doc)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  const id = key.slice(0, key.lastIndexOf(":"))
  latest.delete(id)
  latest.set(id, doc)
  while (latest.size > CACHE_LIMIT) latest.delete(latest.keys().next().value!)
  watchers.get(key)?.forEach((notify) => notify())
}

function pump() {
  while (running < CONCURRENCY && queued.length > 0) {
    const next = queued.shift()!
    // Nobody is looking at this card any more: skip it.
    if (!watchers.get(next.key)?.size || cache.has(next.key)) {
      pending.delete(next.key)
      continue
    }
    running++
    void (async () => {
      try {
        const source = locateNote(next.id)?.source ?? "env"
        const { note } = await noteClient(source).call("notes.get", { id: next.id })
        if (note) remember(keyOf(note), miniMarkdown(note.body))
        // The note moved on while it was read; the card asks again for its new revision.
        if (!note || keyOf(note) !== next.key) failed.add(next.key)
      } catch {
        failed.add(next.key)
      } finally {
        running--
        pending.delete(next.key)
        pump()
      }
    })()
  }
}

function request(key: string, id: string) {
  if (cache.has(key) || pending.has(key) || failed.has(key)) return
  pending.add(key)
  queued.push({ key, id })
  pump()
}

/** The saved text of a note, parsed for its card, without a round trip. */
export function primeNoteThumb(note: Note) {
  remember(keyOf(note), miniMarkdown(note.body))
}

noteBodyListeners.add(primeNoteThumb)

/** True when a note has nothing to show, so there is nothing to read. */
const isBlank = (note: NoteSummary) => !note.preview.trim() && note.checklist.total === 0

/** The thumbnail of a note on screen: null while its text is on the way. */
export function useNoteThumb(note: NoteSummary): MiniDoc | null {
  const key = keyOf(note)
  const blank = isBlank(note)
  const subscribe = useCallback(
    (notify: () => void) => {
      if (blank) return () => {}
      let set = watchers.get(key)
      if (!set) watchers.set(key, (set = new Set()))
      set.add(notify)
      request(key, note.id)
      return () => {
        set.delete(notify)
        if (set.size === 0) watchers.delete(key)
      }
    },
    [key, blank, note.id],
  )
  const read = () => (blank ? EMPTY : cache.get(key) ?? latest.get(note.id) ?? null)
  return useSyncExternalStore(subscribe, read, read)
}

reloadOnHotUpdate(import.meta.hot)
