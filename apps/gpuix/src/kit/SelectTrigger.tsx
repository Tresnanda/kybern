// The select trigger (ADE-55): the secondary button's fill at the control heights (24 / 28 / 32), an optional 14 px provider
// mark, the *display name* of the value (never a raw id such as `claude-code`) and a visible chevron that turns when open.
// `kit/Select` and the Settings `Select` both draw it; they own the popup and pass the input handlers in `input`.
import type { PublicInstance, StyleDesc } from '@gpuix/react'
import type { Ref } from 'react'
import { Chevron } from '../motion/Chevron.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { CONTROL, useControls, type ControlSize } from './controls.ts'

export function SelectTrigger({ children, mark, size = 'md', open = false, disabled = false, placeholder = false, label, width, minWidth, maxWidth, input, triggerRef, testId, style }: {
  /** The value's display name. */
  children: string
  mark?: string
  size?: ControlSize
  open?: boolean
  disabled?: boolean
  /** The value is the placeholder: it reads as `text3`. */
  placeholder?: boolean
  label?: string
  width?: number | `${number}%`
  minWidth?: number
  maxWidth?: number
  /** Handlers and ARIA the owner puts on the trigger (`onClick`, `onKeyDown`, `role`, …). */
  input?: Record<string, unknown>
  triggerRef?: Ref<PublicInstance>
  testId?: string
  style?: StyleDesc
}) {
  const t = useTheme()
  const c = useControls()
  const g = CONTROL[size]
  const fg = disabled ? c.disabled.fg : placeholder ? t.textTertiary : c.secondary.fg
  return (
    <div
      ref={triggerRef as never}
      testId={testId}
      aria-label={label ?? children}
      aria-expanded={open}
      aria-disabled={disabled || undefined}
      {...(input as object)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, height: g.height, minWidth: minWidth ?? 0, ...(maxWidth ? { maxWidth } : {}), ...(width ? { width } : {}),
        paddingLeft: size === 'sm' ? 8 : 10, paddingRight: size === 'sm' ? 6 : 8, borderRadius: g.radius, flexShrink: 0,
        backgroundColor: disabled ? c.disabled.bg : open ? c.secondary.hover : c.secondary.bg, cursor: disabled ? 'default' : 'pointer',
        ...(disabled ? {} : { hover: { backgroundColor: c.secondary.hover }, active: { backgroundColor: c.secondary.press }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }),
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1, pointerEvents: 'none' }}>
        {mark && <ProviderMark kind={mark} size={14} />}
        <Label color={fg} size={g.font} lineHeight={g.line} weight={500} truncate>{children}</Label>
      </div>
      <div style={{ display: 'flex', pointerEvents: 'none' }}>
        <Chevron open={open} source={N.chevronDown} turn={180} duration={0.25} size={12} color={disabled ? c.disabled.fg : t.iconSecondary} />
      </div>
    </div>
  )
}
