// Dialog primitives for the environment flows, mirroring `components/kit/dialog`,
// `button`, `input` and `views/environmentStyles.ts` (measured in the desktop
// frontend: header 16/16/4, title 15/18.75, description 14/22.75, panel gap 16,
// field label 13/19.5 w500, hint 13/21.125, buttons h32 radius 10, disabled 64%).
// TODO(kit9): swap these for the kit button/input/dialog/spinner primitives when they land.
import { motion, useWindowSize } from '@gpuix/react'
import { useState, type ReactNode } from 'react'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { N } from '../nav/glyphs.ts'
import { FONT_MONO, FONT_UI } from '../theme.ts'
import { ink, Label, useTheme } from '../ui.tsx'

const TRIANGLE = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><path d="M1.6 0.4 9.2 5 1.6 9.6Z" fill="#000"/></svg>'

/** `DialogHeader` + `DialogTitle` + `DialogDescription` with the environment overrides. */
export function DialogHeader({ title, description, onClose }: { title: string; description: string; onClose: () => void }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16, paddingRight: 40, paddingTop: 16, paddingBottom: 4, position: 'relative' }}>
    <Label color={t.text} size={15} lineHeight={18.75} weight={600}>{title}</Label>
    <Label color={t.textSecondary} size={14} lineHeight={22.75}>{description}</Label>
    <IconButton testId="dialog-close" label="Close" icon={N.x} onClick={onClose} style={{ position: 'absolute', top: 8, right: 8 }} />
  </div>
}

/** `Button size="icon-sm" variant="ghost"`: 28px, radius 10, 14px glyph. */
export function IconButton({ testId, label, icon, onClick, disabled = false, style = {}, children }: { testId: string; label: string; icon?: string; onClick: () => void; disabled?: boolean; style?: object; children?: ReactNode }) {
  const t = useTheme()
  return <div testId={testId} role="button" aria-label={label} tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) onClick() }} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick() }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, flexShrink: 0, borderRadius: 10, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.64 : 1, hover: { backgroundColor: t.buttonSecondaryHover }, ...style }}>{children ?? <Icon source={icon} size={14} color={t.textSecondary} />}</div>
}

/** `DialogPanel`: a scrolling column that starts flush under the header (the desktop's `pt-0`). */
export function DialogBody({ children, footer = false, testId, scroll = false }: { children: ReactNode; footer?: boolean; testId?: string; scroll?: boolean }) {
  const size = useWindowSize({ intervalMs: 250 })
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingLeft: 16, paddingRight: 16, paddingBottom: footer ? 12 : 16, ...(scroll ? { maxHeight: size.height - 100, minHeight: 0, flexShrink: 1, overflowY: 'scroll' } : {}) }}>{children}</div>
}

/** `DialogFooter`: right-aligned actions, 12px above and below. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}>{children}</div>
}

/** `dialogFieldLabelClassName` over an input: 13px medium at 80% foreground, 6px gap. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Label color={ink(t, .8)} size={13} lineHeight={19.5} weight={500}>{label}</Label>{children}</div>
}

/** `ENVIRONMENT_HINT`. */
export function Hint({ children, center = false, color }: { children: ReactNode; center?: boolean; color?: string }) {
  const t = useTheme()
  return <Label color={color ?? t.textSecondary} size={13} lineHeight={21.125} style={center ? { textAlign: 'center' } : undefined}>{children}</Label>
}

/** `ENVIRONMENT_ERROR`: destructive text for `role="alert"` lines. */
export function ErrorText({ children, testId }: { children: ReactNode; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} role="alert"><Label color={t.red} size={13} lineHeight={21.125}>{children}</Label></div>
}

/** Busy spinner for buttons and rows. TODO(kit9): the desktop's stepped ring spinner. */
export function Spinner({ rgb }: { rgb?: readonly [number, number, number] }) {
  return <MatrixLoader rgb={rgb} />
}

/** Kit `Button` (default size, h-8) with the dialog footer radius of 10 and the busy spinner. */
export function EnvButton({ children, onClick, disabled = false, busy = false, testId, variant = 'primary', size = 'default', icon, block = false }: { children: string; onClick: () => void; disabled?: boolean; busy?: boolean; testId?: string; variant?: 'primary' | 'secondary' | 'ghost' | 'outline'; size?: 'default' | 'xs'; icon?: 'copy'; block?: boolean }) {
  const t = useTheme()
  const xs = size === 'xs'
  // Kit `secondary` (measured in the desktop frontend): dark rgb(104,104,104) on 2.8% white, light rgb(15,15,15) on 4.6% black.
  const dark = t.variant === 'dark'
  const fill = variant === 'primary' ? t.buttonPrimary : variant === 'secondary' ? (dark ? 'rgba(252, 252, 252, 0.0277)' : 'rgba(13, 13, 13, 0.0458)') : 'transparent'
  const hover = variant === 'primary' ? t.buttonPrimary : variant === 'outline' ? t.buttonTertiaryHover : t.buttonSecondaryHover
  const color = variant === 'primary' ? t.buttonPrimaryText : variant === 'secondary' ? (dark ? 'rgb(104, 104, 104)' : 'rgb(15, 15, 15)') : variant === 'ghost' ? t.textSecondary : t.text
  const off = disabled || busy
  const loader = variant === 'primary' ? (t.variant === 'dark' ? [17, 17, 17] as const : [250, 250, 250] as const) : undefined
  return <div testId={testId} role="button" aria-label={children} tabIndex={off ? -1 : 0} onClick={() => { if (!off) onClick() }} onKeyDown={(e) => { if (!off && (e.key === 'enter' || e.key === 'space')) onClick() }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: xs ? 4 : 8, height: xs ? 24 : 32, width: block ? '100%' : undefined, paddingLeft: xs ? 7 : 11, paddingRight: xs ? 7 : 11, borderRadius: xs ? 6 : 10, borderWidth: 1, borderColor: variant === 'outline' ? t.border : 'transparent', backgroundColor: fill, opacity: disabled ? 0.64 : 1, cursor: off ? 'default' : 'pointer', flexShrink: 0, hover: { backgroundColor: hover }, active: { backgroundColor: variant === 'primary' ? t.buttonPrimary : t.buttonSecondaryHover } }}>
    {busy && <div style={{ pointerEvents: 'none' }}><Spinner rgb={loader} /></div>}
    {!busy && icon === 'copy' && <Icon name="copy" size={14} color={color} style={{ pointerEvents: 'none', opacity: 0.8 }} />}
    <Label color={color} size={xs ? 12 : 14} lineHeight={xs ? 18 : 21} weight={500}>{children}</Label>
  </div>
}

/** `Input` in a dialog: h-8, radius 10, soft fill, border darkens on focus and turns red when invalid. */
export function EnvInput({ label, value, onChange, testId, placeholder, disabled = false, invalid = false, mono = false, secure = false, onBlur, onSubmit, autoFocus = false }: { label: string; value: string; onChange: (value: string) => void; testId?: string; placeholder?: string; disabled?: boolean; invalid?: boolean; mono?: boolean; secure?: boolean; onBlur?: () => void; onSubmit?: () => void; autoFocus?: boolean }) {
  const t = useTheme()
  const [focused, setFocused] = useState(false)
  const border = invalid ? (focused ? 'rgba(239, 68, 68, 0.5)' : 'rgba(239, 68, 68, 0.3)') : focused ? ink(t, .3) : ink(t, t.variant === 'dark' ? .07 : .08)
  const extra = secure ? { secure: true } : {}
  return <input {...extra} tabIndex={0} testId={testId} aria-label={label} aria-invalid={invalid} autoFocus={autoFocus} placeholder={placeholder} value={value} readOnly={disabled} onChange={(e) => onChange(e.value ?? '')} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); onBlur?.() }} onSubmit={onSubmit} style={{ width: '100%', height: 32, minWidth: 0, borderWidth: 1, borderColor: border, borderRadius: 10, paddingLeft: 12, paddingRight: 12, fontFamily: mono ? FONT_MONO : FONT_UI, fontSize: 14, color: t.text, backgroundColor: t.variant === 'dark' ? ink(t, .025) : t.v('--background'), opacity: disabled ? 0.64 : 1 }} />
}

/** The `<details>` summary the desktop shows: a small solid triangle that turns down when open. */
export function Disclosure({ label, open, toggle, testId }: { label: string; open: boolean; toggle: () => void; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') toggle() }} style={{ display: 'flex', alignItems: 'center', alignSelf: 'flex-start', gap: 5, paddingTop: 4, paddingBottom: 4, cursor: 'pointer' }}>
    <motion.svg source={TRIANGLE} initial={false} animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0 }} style={{ width: 11, height: 11, color: t.textSecondary, flexShrink: 0 }} />
    <Hint>{label}</Hint>
  </div>
}
