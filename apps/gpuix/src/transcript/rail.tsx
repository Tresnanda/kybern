import { memo, useMemo, useState } from 'react'
import type { TurnGroup } from '../../../../packages/kybern-client/src/transcript.ts'
import { promptText } from '../../../../packages/kybern-client/src/prompts.ts'
import { Dialog, DialogHeader, Tip } from '../nav/overlay.tsx'
import { Label, useTheme } from '../ui.tsx'
import { muted } from './kit.tsx'

const previews = new WeakMap<object, string>()
function previewOf(turn: TurnGroup): string {
  const user = turn.user!
  let preview = previews.get(user)
  if (preview === undefined) {
    preview = promptText(user.message).replace(/\s+/g, ' ').trim().slice(0, 240) || 'Message with attachments'
    previews.set(user, preview)
  }
  return preview
}

/** Data-derived landmarks: no DOM measurement or geometry polling. The compact
 * rail is bounded; the full virtual menu keeps every loaded message reachable. */
export const MessageRail = memo(function MessageRail({ turns, active, onJump }: { turns: TurnGroup[]; active: string | null; onJump: (id: string) => void }) {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const items = useMemo(() => turns.filter(turn => turn.user).map(turn => ({
    id: turn.turnId,
    preview: previewOf(turn),
  })), [turns])
  const marks = useMemo(() => items.filter((_, i) => items.length <= 28 || i === 0 || i === items.length - 1 || i % Math.ceil(items.length / 26) === 0), [items])
  const matches = useMemo(() => items.map((item, index) => ({ ...item, index })).filter(item => item.preview.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [items, query])
  const close = () => { setOpen(false); setQuery('') }
  if (items.length < 2) return null
  return <>
    <div testId="message-rail" style={{ position: 'absolute', left: 20, top: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
      {marks.map(item => <Tip key={item.id} label={item.preview} side="left" size={28}>
        <div testId={`message-jump-${item.id}`} role="button" tabIndex={0} aria-label={item.preview} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onJump(item.id) }} onClick={() => onJump(item.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', width: 28, height: 16, cursor: 'pointer', borderRadius: 4, hover: { backgroundColor: t.buttonSecondaryHover } }}>
          <div style={{ height: 2, width: active === item.id ? 20 : 12, borderRadius: 1, backgroundColor: active === item.id ? t.text : muted(t, 0.45) }} />
        </div>
      </Tip>)}
      <div testId="message-navigation" role="button" tabIndex={0} aria-label="Jump to message" onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') setOpen(true) }} onClick={() => setOpen(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
        <Label color={muted(t)} size={11}>{String(items.length)}</Label>
      </div>
    </div>
    {open && <Dialog onClose={close} width={480} testId="message-navigation-dialog" instant>
      <DialogHeader title="Jump to message" onClose={close} />
      <div style={{ padding: 12, paddingTop: 0 }}><input testId="message-search" autoFocus value={query} onChange={e => setQuery(e.value ?? '')} placeholder="Find a message" style={{ width: '100%', height: 32, paddingLeft: 10, paddingRight: 10, borderRadius: 8, backgroundColor: t.buttonSecondary, color: t.text }} /></div>
      {!matches.length && <div style={{ padding: 16 }}><Label color={muted(t)} size={13}>No matching messages</Label></div>}
      <virtual-list style={{ height: Math.min(420, matches.length * 48) }} estimatedItemHeight={48}>
        {matches.map((item) => <div key={item.id} testId={`message-option-${item.index}`} aria-selected={active === item.id} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') { onJump(item.id); close() } }} onClick={() => { onJump(item.id); close() }} style={{ display: 'flex', gap: 12, alignItems: 'center', height: 48, paddingLeft: 16, paddingRight: 16, cursor: 'pointer', backgroundColor: active === item.id ? t.buttonSecondary : undefined, hover: { backgroundColor: t.buttonSecondaryHover } }}>
          <Label color={muted(t)} size={12}>{String(item.index + 1)}</Label>
          <Label color={t.text} size={13} truncate>{item.preview}</Label>
        </div>)}
      </virtual-list>
    </Dialog>}
  </>
})
