import { useEffect, useState } from 'react'
import type { Note } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { load, save } from '../shell/persist.ts'
import { Button } from '../kit/Button.tsx'
import { TextArea } from '../kit/TextArea.tsx'
import { Label, useTheme } from '../ui.tsx'
import { errorText } from '../nav/actions.ts'

/** Compact Markdown draft. Revision checks keep edits from overwriting another client. */
export function ThreadNote({ threadId }: { threadId: string }) {
  const t = useTheme()
  const key = `kybern.env.note-draft.${threadId}`
  const [note, setNote] = useState<Note | null>(null)
  const [body, setBody] = useState(() => load<string | null>(key, null) ?? '')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    void getClient()!.call('notes.get', { thread_id: threadId }).then(({ note }) => {
      if (!live) return
      setNote(note ?? null)
      setBody(load<string | null>(key, null) ?? note?.body ?? '')
      setLoaded(true)
    }, (e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [threadId, key, reload])
  const commit = async () => {
    if (busy || !loaded) return
    setBusy(true); setError('')
    const client = getClient()!
    try {
      const next = await client.call('notes.update', { thread_id: threadId, expected_revision: note?.revision ?? 0, body })
      if (getClient() !== client) return
      setNote(next); save(key, undefined)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const dirty = body !== (note?.body ?? '')
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 8, paddingRight: 8, paddingBottom: 8 }}>
    <TextArea testId="environment-note" label="Thread note" value={body} disabled={!loaded || busy} placeholder="Ideas, reminders, to-dos. Type / for formatting" minRows={4} maxRows={10}
      onChange={(value) => { setBody(value); save(key, value) }} />
    {error && <><Label color={t.red} size={11}>{error}</Label><Button size="sm" onClick={() => { setError(''); setReload((n) => n + 1) }}>Reload saved revision</Button></>}
    {dirty && <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Button size="sm" variant="primary" testId="environment-note-save" disabled={!loaded || busy} onClick={() => void commit()}>{busy ? 'Saving…' : 'Save note'}</Button></div>}
  </div>
}
