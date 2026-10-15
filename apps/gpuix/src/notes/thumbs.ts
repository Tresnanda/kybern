// Gallery thumbnails: a card asks for its note's body when mounted; the body is
// read once per revision, parsed into a small MiniDoc and dropped. Bounded LRU,
// three requests at a time (desktop `state/noteThumbs.ts`).
import { useEffect, useSyncExternalStore } from 'react'
import { miniMarkdown, type MiniDoc } from '@/state/miniMarkdown'
import type { NoteSummary } from '../../../../packages/kybern-client/src/types.ts'
import { rpc } from './store.ts'

const LIMIT = 240
const cache = new Map<string, MiniDoc>()
const failed = new Set<string>()
const pending = new Set<string>()
const queue: { key: string; id: string }[] = []
const listeners = new Set<() => void>()
let running = 0
let version = 0
const keyOf = (n: Pick<NoteSummary, 'id' | 'revision'>) => `${n.id}:${n.revision}`

function pump() {
  while (running < 3 && queue.length) {
    const next = queue.shift()!
    running++
    void (async () => {
      try {
        const { note } = await rpc(next.id).call('notes.get', { id: next.id })
        if (note) {
          cache.set(keyOf(note), miniMarkdown(note.body))
          while (cache.size > LIMIT) cache.delete(cache.keys().next().value!)
        } else failed.add(next.key)
      } catch { failed.add(next.key) } finally {
        running--
        pending.delete(next.key)
        version++
        listeners.forEach((l) => l())
        pump()
      }
    })()
  }
}

/** The parsed body of `note`, or null while it is being read. */
export function useNoteThumb(note: NoteSummary): MiniDoc | null {
  const key = keyOf(note)
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => version)
  useEffect(() => {
    if (cache.has(key) || pending.has(key) || failed.has(key)) return
    pending.add(key); queue.push({ key, id: note.id }); pump()
  }, [key, note.id])
  return cache.get(key) ?? null
}
