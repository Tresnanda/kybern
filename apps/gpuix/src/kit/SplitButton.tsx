// One shape, one variant: a label part, a 1 px divider (22% of the label colour, inset 6) and a 24 px menu part that opens
// `children` (menu items). The halves share the outer radius. Example: the PR header's "Merge ⌄". Replaces the two
// radius-patched Buttons the PR header drew and the Notes compose + chevron pair.
import type { StyleDesc } from '@gpuix/react'
import type { ReactNode } from 'react'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu } from '../nav/overlay.tsx'
import { Label } from '../ui.tsx'
import { CONTROL, useControls, type ControlSize } from './controls.ts'

export interface SplitButtonProps {
  children: string
  variant?: 'primary' | 'secondary'
  size?: ControlSize
  onClick: () => void
  disabled?: boolean
  /** The menu part stays live while the label part is disabled (a blocked Merge still offers Close). */
  keepMenu?: boolean
  /** The menu part's items (`MenuItem`s). */
  menu: ReactNode
  menuAlign?: 'start' | 'center' | 'end'
  testId?: string
  menuTestId?: string
  menuLabel?: string
  style?: StyleDesc
}

export function SplitButton({ children, variant = 'primary', size = 'md', onClick, disabled = false, keepMenu = false, menu, menuAlign = 'end', testId, menuTestId, menuLabel = 'More actions', style }: SplitButtonProps) {
  const c = useControls()
  const g = CONTROL[size]
  const v = variant === 'primary' ? c.primary : c.secondary
  const fg = disabled ? c.disabled.fg : v.fg
  const bg = disabled ? c.disabled.bg : v.bg
  const r = g.radius
  const weight = variant === 'primary' ? 600 : 500
  const menuOff = disabled && !keepMenu
  const mfg = menuOff ? c.disabled.fg : v.fg
  const mbg = menuOff ? c.disabled.bg : v.bg
  const part: StyleDesc = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: g.height, backgroundColor: bg, cursor: disabled ? 'default' : 'pointer' }
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, ...style }}>
      <div
        testId={testId} role="button" aria-label={children} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
        onClick={disabled ? undefined : onClick} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick() }}
        style={{ ...part, paddingLeft: g.padX, paddingRight: g.padX - 2, borderTopLeftRadius: r, borderBottomLeftRadius: r, ...(disabled ? {} : { hover: { backgroundColor: v.hover }, active: { backgroundColor: v.press }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }) }}
      >
        <Label color={fg} size={g.font} lineHeight={g.line} weight={weight} style={{ whiteSpace: 'nowrap', pointerEvents: 'none' }}>{children}</Label>
      </div>
      {/* The seam keeps the fill continuous; the line is 22% of the label colour. */}
      <div style={{ position: 'relative', width: 1, height: g.height, backgroundColor: bg, flexShrink: 0 }}>
        <div style={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 1, backgroundColor: fg, opacity: 0.22 }} />
      </div>
      <Menu testId={menuTestId} align={menuAlign} trigger={() => (
        <div role="button" aria-label={menuLabel} style={{ ...part, backgroundColor: mbg, cursor: menuOff ? 'default' : 'pointer', width: 24, borderTopRightRadius: r, borderBottomRightRadius: r, ...(menuOff ? {} : { hover: { backgroundColor: v.hover }, active: { backgroundColor: v.press } }) }}>
          <Icon source={N.chevronDown} size={12} color={mfg} style={{ pointerEvents: 'none' }} />
        </div>
      )}>{menuOff ? null : menu}</Menu>
    </div>
  )
}
