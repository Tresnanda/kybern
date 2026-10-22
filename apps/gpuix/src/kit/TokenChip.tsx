// Chip kind 2 of 2: the token chip. A removable value: 24 tall pill, an optional lead, the label and a ✕ (18 hit, 11 glyph).
// Replaces the Computer-use app chips and the `Combobox` multiple-selection chips.
import type { StyleDesc } from '@gpuix/react'
import type { ReactNode } from 'react'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, useTheme } from '../ui.tsx'
import { HEIGHT, RADIUS, useControls } from './controls.ts'

export function TokenChip({ children, lead, onRemove, removeLabel, disabled = false, testId, style }: {
  children: string
  lead?: ReactNode
  /** Shows the ✕ when set. */
  onRemove?: () => void
  /** Accessible name of the ✕ (default "Remove <label>"). */
  removeLabel?: string
  disabled?: boolean
  testId?: string
  style?: StyleDesc
}) {
  const t = useTheme()
  const c = useControls()
  return (
    <div testId={testId} style={{ display: 'flex', alignItems: 'center', gap: 4, height: HEIGHT.sm, minWidth: 0, flexShrink: 0, paddingLeft: 8, paddingRight: onRemove ? 3 : 8, borderRadius: RADIUS.pill, backgroundColor: c.token.bg, ...style }}>
      {lead}
      <Label color={disabled ? c.disabled.fg : t.text} size={12} lineHeight={16} weight={500} truncate>{children}</Label>
      {onRemove && (
        <div
          testId={testId ? `${testId}-remove` : undefined}
          role="button" tabIndex={disabled ? -1 : 0} aria-label={removeLabel ?? `Remove ${children}`}
          onClick={disabled ? undefined : onRemove}
          onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onRemove() }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: RADIUS.pill, flexShrink: 0, cursor: disabled ? 'default' : 'pointer', hover: { backgroundColor: c.ink(0.1) }, active: { backgroundColor: c.ink(0.15) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }}
        >
          <Icon source={N.x} size={11} color={t.textTertiary} style={{ pointerEvents: 'none' }} />
        </div>
      )}
    </div>
  )
}
