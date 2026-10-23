// What a composer keeps while it is away: a thread's or project's text and attachments, by draft key. A request card that
// replaces the composer (`transcript/Requests.tsx`) unmounts it; the new composer reads the draft back, so nothing typed
// before the card, or while it waited for the reader to pause (`requests/typingGuard.ts`), is lost.
export interface StoredDraft<A> { text: string; attachments: A[] }

const LIMIT = 100

export function createDraftStore<A>(load: () => [string, StoredDraft<A>][], save: (entries: [string, StoredDraft<A>][]) => void) {
  const drafts = new Map<string, StoredDraft<A>>(load())
  const persist = () => save([...drafts].slice(-LIMIT))
  return {
    get: (key: string) => drafts.get(key),
    /** Keeps the draft, or forgets the key when both parts are empty, and writes the result out. */
    keep(key: string, text: string, attachments: A[]) {
      if (text || attachments.length) drafts.set(key, { text, attachments })
      else drafts.delete(key)
      persist()
    },
    /** Forgets a draft that left (sent); `persist` writes it out when the caller does not do so itself. */
    drop(key: string, persistNow = false) {
      drafts.delete(key)
      if (persistNow) persist()
    },
    /** Replaces everything with what storage holds (another environment became active). */
    reload() {
      drafts.clear()
      for (const [key, value] of load()) drafts.set(key, value)
    },
    persist,
  }
}
