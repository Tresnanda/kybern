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
  const items = useMemo(() => turns.filter(turn => turn.user).map(turn => ({
    id: turn.turnId,
    preview: previewOf(turn),
  })), [turns])
  const marks = useMemo(() => items.filter((_, i) => items.length <= 28 || i === 0 || i === items.length - 1 || i % Math.ceil(items.length / 26) === 0), [items])
  if (items.length < 2) return null
  return <>
    <div testId="message-rail" style={{ position: 'absolute', right: 10, top: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      {marks.map(item => <Tip key={item.id} label={item.preview} side="left" size={28}>
        <div testId={`message-jump-${item.id}`} role="button" aria-label={item.preview} onClick={() => onJump(item.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', width: 28, height: 16, cursor: 'pointer', borderRadius: 4, hover: { backgroundColor: t.buttonSecondaryHover } }}>
          <div style={{ height: 2, width: active === item.id ? 20 : 12, borderRadius: 1, backgroundColor: active === item.id ? t.text : muted(t, 0.45) }} />
        </div>
      </Tip>)}
      <div testId="message-navigation" role="button" aria-label="Jump to message" onClick={() => setOpen(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
        <Label color={muted(t)} size={11}>{String(items.length)}</Label>
      </div>
    </div>
    {open && <Dialog onClose={() => setOpen(false)} width={480} testId="message-navigation-dialog" instant>
      <DialogHeader title="Jump to message" onClose={() => setOpen(false)} />
      <virtual-list style={{ height: Math.min(420, items.length * 48) }} estimatedItemHeight={48}>
        {items.map((item, i) => <div key={item.id} testId={`message-option-${i}`} onClick={() => { onJump(item.id); setOpen(false) }} style={{ display: 'flex', gap: 12, alignItems: 'center', height: 48, paddingLeft: 16, paddingRight: 16, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
          <Label color={muted(t)} size={12}>{String(i + 1)}</Label>
          <Label color={t.text} size={13} truncate>{item.preview}</Label>
        </div>)}
      </virtual-list>
    </Dialog>}
  </>
})
