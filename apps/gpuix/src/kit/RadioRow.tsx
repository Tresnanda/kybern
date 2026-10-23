// A radio list row: radius 12, the radio, a 14/500 title and an optional 13 px secondary description; the selected row takes the
// accent tint. The whole row is the hit area. The caller wraps rows in `role="radiogroup"`.
import type { StyleDesc } from '@gpuix/react'
import type { ReactNode } from 'react'
import { Label, useTheme } from '../ui.tsx'
import { useControls } from './controls.ts'
import { Radio } from './Radio.tsx'

export function RadioRow({ checked, title, description, onSelect, disabled = false, children, testId, style }: {
  checked: boolean
  title: string
  description?: string
  onSelect: () => void
  disabled?: boolean
  /** Extra content under the text (an answer field). */
  children?: ReactNode
  testId?: string
  style?: StyleDesc
}) {
  const t = useTheme()
  const c = useControls()
  return (
    <div
      testId={testId} role="radio" aria-checked={checked} aria-label={title} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onSelect() }}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: 8, borderRadius: 12, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer',
        backgroundColor: checked ? c.optionSelected : 'rgba(0, 0, 0, 0)',
        ...(disabled ? {} : { hover: { backgroundColor: checked ? c.optionSelected : c.ink(0.04) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }),
        ...style,
      }}
    >
      <div style={{ display: 'flex', paddingTop: 2 }}><Radio checked={checked} disabled={disabled} /></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
        <Label color={t.text} size={14} lineHeight={20} weight={500} style={{ pointerEvents: 'none' }}>{title}</Label>
        {description && <Label color={t.textSecondary} size={13} lineHeight={19} style={{ pointerEvents: 'none' }}>{description}</Label>}
        {children}
      </div>
    </div>
  )
}
