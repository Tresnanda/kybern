// The Coordinator's "Tidy notes" offer for its project (`notes.tidy_offer`), read when the thread opens and again whenever
// notes change (an edit, a new claim, a checked-off stale flag). The card in the composer stack follows it.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TidyOffer } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'

export function useTidyOffer(projectId: string | null | undefined): [TidyOffer | null, (offer: TidyOffer) => void] {
  const [offer, setOffer] = useState<{ projectId: string; offer: TidyOffer } | null>(null)
  const request = useRef(0)
  const read = useCallback(async () => {
    const client = getClient()
    if (!projectId || !client) return
    const mine = ++request.current
    try {
      const result = await client.call('notes.tidy_offer', { project_id: projectId })
      if (mine === request.current) setOffer({ projectId, offer: result })
    } catch { /* An older daemon has no offer: the card never shows. */ }
  }, [projectId])
  useEffect(() => {
    if (!projectId) return
    void read()
    const off = getClient()?.onNotification('notes.changed', () => void read())
    return () => { request.current++; off?.() }
  }, [projectId, read])
  return [offer && offer.projectId === projectId ? offer.offer : null, (next) => setOffer(projectId ? { projectId, offer: next } : null)]
}
