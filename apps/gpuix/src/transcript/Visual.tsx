import { memo, useEffect, useRef, useState } from 'react'
import { spawn } from 'node:child_process'
import type { HtmlVisual } from '../../../../packages/kybern-client/src/types.ts'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import { visualThemeFragment } from '../../../../packages/kybern-client/src/visuals.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { Button, muted } from './kit.tsx'
import { TextDetail } from './markdown.tsx'
import { reportError } from './store.ts'

/** Browser entry point until GPUIX provides an isolated embedded web surface.
 * Read source on demand only; never execute agent HTML in the native process. */
export const VisualCard = memo(function VisualCard({ visual, threadId }: { visual: HtmlVisual; threadId: string }) {
  const t = useTheme()
  const [source, setSource] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const tickets = useRef<{ client: NonNullable<ReturnType<typeof getClient>>; ticket: string }[]>([])
  useEffect(() => { alive.current = true; return () => {
    alive.current = false
    for (const { client, ticket } of tickets.current) void client.call('threads.visuals.revoke', { thread_id: threadId, ticket }).catch(() => {})
    tickets.current = []
  } }, [threadId, visual.id])
  const open = async (read: boolean) => {
    if (busy) return
    const client = getClient(), owner = activeEnvironment()
    if (!client) return
    setBusy(true)
    try {
      if (read) {
        const result = await client.call('threads.visuals.read', { thread_id: threadId, visual_id: visual.id, max_bytes: 512000 })
        if (alive.current && owner === activeEnvironment()) setSource(result.html + (result.truncated ? '\n<!-- Source truncated -->' : ''))
      } else {
        const { ticket } = await client.call('threads.visuals.frame', { thread_id: threadId, visual_id: visual.id })
        if (!alive.current || owner !== activeEnvironment()) { await client.call('threads.visuals.revoke', { thread_id: threadId, ticket }); return }
        // Bound outstanding tickets even after repeated clicks.
        for (const old of tickets.current.splice(0)) void old.client.call('threads.visuals.revoke', { thread_id: threadId, ticket: old.ticket }).catch(() => {})
        tickets.current.push({ client, ticket })
        const url = `${httpBase(client.endpoint.url)}/visual-frame/${encodeURIComponent(ticket)}` + visualThemeFragment({ appearance: t.variant, variables: {} })
        spawn('open', [url]).on('error', e => reportError('Unable to open visual', e))
      }
    } catch (e) { if (alive.current && owner === activeEnvironment()) reportError('Unable to open visual', e) }
    finally { if (alive.current) setBusy(false) }
  }
  return <div testId="visual-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, marginTop: 8, marginBottom: 8, borderRadius: 10, borderWidth: 1, borderColor: t.border }}>
    <Label color={t.text} weight={500}>{visual.title || 'Interactive visual'}</Label>
    <Label color={muted(t)} size={12}>Opens in your browser</Label>
    <div style={{ display: 'flex', gap: 8 }}><Button testId="visual-open" disabled={busy} onClick={() => void open(false)}>Open visual</Button><Button testId="visual-source" variant="ghost" disabled={busy} onClick={() => void open(true)}>View HTML</Button></div>
    {source !== null && <TextDetail text={source} title={visual.title || 'Visual HTML'} code onClose={() => setSource(null)} />}
  </div>
})
