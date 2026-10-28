// A small "ask an agent" action that sits where the problem is: a failing check's "Fix with agent", a review's "Address feedback".
// Accent tint at 16% (24% on hover), 22 px high, radius 7, a 13 px sparkle and a 12/500 label. Not a `Button`: it is quieter than
// even a small secondary, so a card with three of them still has one primary.
import { Icon } from '../icons.tsx'
import { G } from '../pulls/detail/glyphs.ts'
import { Label } from '../ui.tsx'
import { useControls } from './controls.ts'

export function AgentAction({ children, onClick, disabled = false, testId }: { children: string; onClick: () => void; disabled?: boolean; testId?: string }) {
  const c = useControls()
  return (
    <div testId={testId} role="button" aria-label={children} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onClick} onKeyDown={e => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick() }}
      style={{ display: 'flex', alignItems: 'center', gap: 4, height: 22, paddingLeft: 6, paddingRight: 7, borderRadius: 7, flexShrink: 0, backgroundColor: c.acc(0.16), cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, ...(disabled ? {} : { hover: { backgroundColor: c.acc(0.24) }, active: { backgroundColor: c.acc(0.3) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }) }}>
      <Icon source={G.agent} size={13} color={c.accentFg} style={{ pointerEvents: 'none' }} />
      <Label color={c.accentFg} size={12} lineHeight={16} weight={500} style={{ whiteSpace: 'nowrap', pointerEvents: 'none' }}>{children}</Label>
    </div>
  )
}
