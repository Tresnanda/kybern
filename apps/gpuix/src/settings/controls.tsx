import { motion, type InputProps } from '@gpuix/react'
import { Children, useEffect, useState, type ReactNode } from 'react'
import { PickerMenu, PickerItem, CheckMark } from '../composer/Menu.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { EASE_OUT, ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { FONT_UI } from '../theme.ts'

export function Button({ children, onClick, disabled = false, testId, variant = 'outline', size = 'default', icon, label }: { variant?: 'outline' | 'primary' | 'destructive' | 'ghost' | 'secondary' | 'subtle'; size?: 'default' | 'chip' | 'xs'; children: string; onClick: () => void; disabled?: boolean; testId?: string; /** Leading glyph (`kit` buttons put 16px icons beside the label). */ icon?: string; label?: string }) {
  const t = useTheme()
  const chip = size === 'chip' || size === 'xs'
  const text = size === 'xs' ? 12 : 13
  const fill = variant === 'primary' ? t.buttonPrimary : variant === 'destructive' ? t.red : variant === 'secondary' || variant === 'subtle' ? t.buttonSecondary : 'transparent'
  const hover = variant === 'primary' ? t.buttonPrimary : variant === 'destructive' ? t.red : variant === 'subtle' || variant === 'ghost' ? t.buttonSecondaryHover : t.buttonTertiaryHover
  const color = variant === 'primary' ? t.buttonPrimaryText : variant === 'destructive' ? '#fff' : variant === 'ghost' ? t.textSecondary : t.text
  return <div testId={testId} role="button" tabIndex={disabled ? -1 : 0} aria-label={label ?? children} onClick={() => !disabled && onClick()} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick() }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: chip ? 4 : 6, minHeight: chip ? 24 : variant === 'outline' || variant === 'ghost' || variant === 'subtle' ? 28 : 32, backgroundColor: fill, paddingLeft: chip ? 8 : 10, paddingRight: chip ? 8 : 10, borderWidth: variant === 'outline' ? 1 : 0, borderColor: t.border, borderRadius: chip ? 8 : 8, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer', flexShrink: 0, hover: { backgroundColor: hover }, active: { backgroundColor: variant === 'primary' ? t.buttonPrimary : variant === 'destructive' ? t.red : t.buttonSecondaryHover } }}>{icon && <Icon source={icon} size={chip ? 12 : 14} color={color} style={{ pointerEvents: 'none' }} />}<Label color={color} size={chip ? text : 14} lineHeight={chip ? text * 1.5 : 21}>{children}</Label></div>
}

/** Pointer toggles give state feedback in 160ms; keyboard and Reduce Motion are immediate. */
/**
 * The desktop's `Switch` (`components/kit/switch.tsx`): a 32×20 track, accent when
 * on, with a white 16px thumb that slides 200 ms ease-out and stretches while
 * pressed. Keyboard toggles and Reduce Motion change without movement.
 */
export function Switch({ checked, onChange, label, disabled = false, testId }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  const t = useTheme()
  const [keyboard, setKeyboard] = useState(false)
  const [pressed, setPressed] = useState(false)
  const still = keyboard || REDUCED_MOTION
  // The thumb widens by 2px toward the track's centre, like the desktop's scale-x 1.1.
  const stretch = pressed && !disabled ? 2 : 0
  return (
    <div
      testId={testId}
      role="switch"
      aria-label={label}
      aria-checked={checked}
      tabIndex={disabled ? -1 : 0}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      onClick={() => {
        if (disabled) return
        setKeyboard(false)
        onChange(!checked)
      }}
      onKeyDown={(e) => {
        if (disabled || (e.key !== 'enter' && e.key !== 'space')) return
        setKeyboard(true)
        onChange(!checked)
      }}
      // A 38×28 hit area around the 32×20 track.
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 28, flexShrink: 0, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.64 : 1 }}
    >
      <div
        style={{
          pointerEvents: 'none',
          position: 'relative',
          width: 32,
          height: 20,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: checked ? t.switchOn : t.switchOffBorder,
          backgroundColor: checked ? t.switchOn : t.switchOff,
        }}
      >
        <motion.div
          initial={false}
          animate={{ left: checked ? 13 - stretch : 1, width: 16 + stretch }}
          transition={{ duration: still ? 0 : 0.2, ease: EASE_OUT }}
          style={{
            pointerEvents: 'none',
            position: 'absolute',
            top: 1,
            height: 16,
            borderRadius: 8,
            backgroundColor: '#ffffff',
            borderWidth: 0.5,
            borderColor: 'rgba(0, 0, 0, 0.05)',
            boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.12)' },
          }}
        />
      </div>
    </div>
  )
}

let openModals = 0
let modalClosedAt = 0
/** Keep a dialog's Escape from also dismissing its containing Settings page. */
export function useSettingsModal(open: boolean) {
  useEffect(() => {
    if (!open) return
    openModals++
    return () => { openModals--; modalClosedAt = Date.now() }
  }, [open])
}

let openSelects = 0
let selectClosedAt = 0
/** Native key events also reach ancestors; let Escape dismiss a picker first. */
export const selectOwnsEscape = () => openSelects > 0 || Date.now() - selectClosedAt < 100
export const settingsOverlayOwnsEscape = () => selectOwnsEscape() || openModals > 0 || Date.now() - modalClosedAt < 100

/** `mark` draws the agent's mark (12px) before the label, like the desktop's `SettingsPicker`. */
export interface Option { value: string; label: string; disabled?: boolean; mark?: string }
export function Select({ value, onChange, options, label, disabled, testId, compact = false }: { value: string; onChange: (value: string) => void; options: readonly Option[]; label: string; disabled?: boolean; testId?: string; compact?: boolean }) {
  const t = useTheme()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  useEffect(() => { if (!open) return; openSelects++; return () => { openSelects--; selectClosedAt = Date.now() } }, [open])
  const filtered = options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
  const current = options.find((o) => o.value === value)
  return <PickerMenu open={open} testId={testId} disabled={disabled} side="bottom" align="end" minWidth={190} onOpenChange={(next) => { setOpen(next); setQuery('') }} trigger={() => <div aria-label={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: compact ? 6 : 12, minWidth: compact ? 96 : 144, maxWidth: 248, height: 28, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingLeft: 10, paddingRight: 8, opacity: disabled ? 0.45 : 1, hover: { backgroundColor: t.hover } }}><div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1 }}>{current?.mark && <ProviderMark kind={current.mark} size={12} />}<Label color={t.text} size={14} lineHeight={21} truncate>{current?.label ?? value}</Label></div><Icon source={N.chevronDown} size={12} color={t.iconSecondary} /></div>}>
    {options.length > 10 && <TextField label={`Search ${label}`} value={query} onChange={setQuery} width={230} />}
    <virtual-list style={{ width: 250, height: Math.max(28, Math.min(filtered.length, 9) * 28) }}>
      {filtered.map((option) => <PickerItem key={option.value} id={option.value} testId={testId ? `${testId}-${option.value}` : undefined} disabled={option.disabled} onSelect={() => onChange(option.value)} style={{ height: 28 }}>{option.mark && <ProviderMark kind={option.mark} size={12} />}<Label color={t.text} size={12} truncate style={{ flexGrow: 1 }}>{option.label}</Label><CheckMark color={t.text} visible={option.value === value} /></PickerItem>)}
    </virtual-list>
  </PickerMenu>
}

export function Segmented({ value, onChange, options, label, width = 110, disabled }: { value: string; onChange: (value: string) => void; options: readonly Option[]; label: string; width?: number; disabled?: boolean }) {
  const t = useTheme()
  const [keyboard, setKeyboard] = useState(false)
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  return <div aria-label={label} style={{ display: 'flex', position: 'relative', padding: 3, borderRadius: 8, backgroundColor: t.buttonSecondary, opacity: disabled ? 0.45 : 1 }}>
    <motion.div initial={false} animate={{ left: 3 + index * width }} transition={{ duration: keyboard || REDUCED_MOTION ? 0 : 0.22, ease: EASE_OUT }} style={{ position: 'absolute', top: 3, width, height: 28, borderRadius: 5, backgroundColor: t.surface }} />
    {options.map((option) => <div key={option.value} tabIndex={disabled ? -1 : 0} aria-label={option.label} aria-pressed={value === option.value} onClick={() => { if (!disabled) { setKeyboard(false); onChange(option.value) } }} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) { setKeyboard(true); onChange(option.value) } }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', width, height: 28, cursor: 'pointer' }}><Label color={value === option.value ? t.text : t.textSecondary} size={12}>{option.label}</Label></div>)}
  </div>
}

export function TextField({ label, value, onChange, width = 180, ...props }: Omit<InputProps, 'value' | 'onChange'> & { label: string; value: string; onChange: (value: string) => void; width?: number | `${number}%` }) {
  const t = useTheme()
  return <input {...props} aria-label={label} value={value} onChange={(e) => onChange(e.value ?? '')} style={{ width, height: 30, minWidth: 0, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingLeft: 10, paddingRight: 10, fontFamily: FONT_UI, fontSize: 12, color: t.text, backgroundColor: t.surface, ...props.style }} />
}

export function NumberField({ value, onCommit, label, unit = '', min = 0, max = 100000, step = 1, disabled, testId }: { value: number; onCommit: (value: number) => void; label: string; unit?: string; min?: number; max?: number; step?: number; disabled?: boolean; testId?: string }) {
  const t = useTheme()
  const [draft, setDraft] = useState(value===0&&min===0?'':String(value))
  const [adopted, setAdopted] = useState(value)
  if (value !== adopted) { setAdopted(value); setDraft(value===0&&min===0?'':String(value)) }
  const commit = (text: string) => {
    if (disabled) return
    const next = text.trim() === '' ? (min === 0 ? 0 : value) : Number(text)
    if (!Number.isFinite(next)) { setDraft(value===0&&min===0?'':String(value)); return }
    const bounded = Math.min(max, Math.max(min, Math.round(next)))
    setDraft(bounded===0&&min===0?'':String(bounded))
    if (bounded !== value) onCommit(bounded)
  }
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><TextField testId={testId} label={label} placeholder={min===0?'Off':undefined} value={draft} onChange={setDraft} width={72} style={{fontSize:14,backgroundColor:t.variant === 'dark' ? ink(t,.016) : t.v('--background'),borderColor:ink(t,t.variant === 'dark' ? .05 : .06)}} readOnly={disabled} onBlur={() => commit(draft)} onSubmit={() => commit(draft)} onKeyDown={(e) => { if (e.key === 'enter') commit(draft); if (e.key === 'escape') setDraft(value===0&&min===0?'':String(value)); if (e.key === 'up' || e.key === 'down') commit(String((Number(draft) || 0) + (e.key === 'up' ? 1 : -1) * step * (e.modifiers?.shift ? 10 : 1))) }} /><Label color={t.textSecondary} size={12} style={{width:44, opacity: value === 0 && min === 0 ? .4 : 1}}>{unit}</Label></div>
}

export function PageBlock({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'center', width: '100%', paddingLeft: 40, paddingRight: 40 }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 680 }}>{children}</div></div>
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme()
  const rows = Children.toArray(children)
  return <PageBlock><div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 30 }}><Label color={t.text} size={14} lineHeight={19.6} weight={600} style={{ paddingLeft: 2 }}>{title}</Label><div style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.v('--app-settings-card-border'), borderRadius: 12, backgroundColor: t.v('--app-settings-card-surface'), overflow: 'hidden' }}>{rows.map((row, i) => <div key={i} style={{ borderTopWidth: i ? 1 : 0, borderColor: t.v('--app-settings-card-border') }}>{row}</div>)}</div></div></PageBlock>
}

export function Row({ title, description, status, children }: { title: string; description?: ReactNode; status?: string; children?: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, paddingLeft: 18, paddingRight: 18, paddingTop: 16, paddingBottom: 16 }}><div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, minWidth: 0 }}>{title && <Label color={t.text} size={14} lineHeight={21} weight={500}>{title}</Label>}{description && (typeof description === 'string' ? <Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451 }}>{description}</Label> : description)}{status && <Label color={t.textSecondary} size={11} lineHeight={16.5} style={{ maxWidth: 451, paddingTop: 4 }}>{status}</Label>}</div>{children && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{children}</div>}</div>
}
