// A number field: the value on the left, the unit inside on the trailing edge in `text3` 12, tabular digits. Commits on blur,
// Enter or the arrow keys (Shift ×10); Escape reverts. With a 0 minimum, 0 reads as "Off": the field is empty and the unit dims.
// Moved here from `settings/controls.tsx`.
import { useState } from 'react'
import { fadeTo } from '../shell/motion.ts'
import { Label, useTheme } from '../ui.tsx'
import { TextField } from './Field.tsx'

export function NumberField({ value, onCommit, label, unit = '', min = 0, max = 100000, step = 1, disabled, width = 88, testId }: { value: number; onCommit: (value: number) => void; label: string; unit?: string; min?: number; max?: number; step?: number; disabled?: boolean; width?: number; testId?: string }) {
  const t = useTheme()
  const off = value === 0 && min === 0
  const shown = (n: number) => (n === 0 && min === 0 ? '' : String(n))
  const [draft, setDraft] = useState(shown(value))
  const [adopted, setAdopted] = useState(value)
  // The unit dims over 150 ms when the field turns off.
  const dim = fadeTo(off ? 0.4 : 1)
  if (value !== adopted) { setAdopted(value); setDraft(shown(value)) }
  const commit = (text: string) => {
    if (disabled) return
    const next = text.trim() === '' ? (min === 0 ? 0 : value) : Number(text)
    if (!Number.isFinite(next)) { setDraft(shown(value)); return }
    const bounded = Math.min(max, Math.max(min, Math.round(next)))
    setDraft(shown(bounded))
    if (bounded !== value) onCommit(bounded)
  }
  return (
    <TextField
      testId={testId} label={label} placeholder={min === 0 ? 'Off' : undefined} value={draft} onChange={setDraft} width={width} disabled={disabled}
      style={{ fontVariantNumeric: 'tabular-nums' } as never}
      trailing={unit ? <div paintTransform={dim.paintTransform} style={{ display: 'flex', flexShrink: 0, pointerEvents: 'none', ...dim.style }}><Label color={t.textTertiary} size={12} lineHeight={16}>{unit}</Label></div> : undefined}
      onBlur={() => commit(draft)} onSubmit={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'enter') commit(draft)
        if (e.key === 'escape') setDraft(shown(value))
        if (e.key === 'up' || e.key === 'down') commit(String((Number(draft) || 0) + (e.key === 'up' ? 1 : -1) * step * (e.modifiers?.shift ? 10 : 1)))
      }}
    />
  )
}
