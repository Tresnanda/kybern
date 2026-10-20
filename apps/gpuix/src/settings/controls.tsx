import type { InputProps } from '@gpuix/react'
import type { PaintTransformProps } from '@gpuix/native/host'
import { Children, createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { PickerMenu, PickerItem, CheckMark } from '../composer/Menu.tsx'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { N } from '../nav/glyphs.ts'
import { ink, Label, ProviderMark, useTheme } from '../ui.tsx'
import { FONT_UI } from '../theme.ts'
import { pressTransform } from '../motion/press.ts'
import { Chevron } from '../motion/Chevron.tsx'
import { SwapOnChange, enterTransform } from '../motion/kit.tsx'
import { fadeTo } from '../shell/motion.ts'
import { SlidingPill } from '../usage/controls.tsx'

export function Button({ children, onClick, disabled = false, testId, variant = 'outline', size = 'default', icon, label, busy = false }: { variant?: 'outline' | 'primary' | 'destructive' | 'ghost' | 'secondary' | 'subtle'; size?: 'default' | 'chip' | 'xs'; children: string; onClick: () => void; disabled?: boolean; testId?: string; /** Leading glyph (`kit` buttons put 16px icons beside the label). */ icon?: string; label?: string; /** A loader before the label while work is pending. */ busy?: boolean }) {
  const t = useTheme()
  const chip = size === 'chip' || size === 'xs'
  const text = size === 'xs' ? 12 : 13
  const fill = variant === 'primary' ? t.buttonPrimary : variant === 'destructive' ? t.red : variant === 'secondary' || variant === 'subtle' ? t.buttonSecondary : 'transparent'
  const hover = variant === 'primary' ? t.buttonPrimary : variant === 'destructive' ? t.red : variant === 'subtle' || variant === 'ghost' ? t.buttonSecondaryHover : t.buttonTertiaryHover
  const color = variant === 'primary' ? t.buttonPrimaryText : variant === 'destructive' ? '#fff' : variant === 'ghost' ? t.textSecondary : t.text
  return <div testId={testId} role="button" tabIndex={disabled ? -1 : 0} aria-label={label ?? children} onClick={() => !disabled && onClick()} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick() }} paintTransform={pressTransform(!disabled)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: chip ? 4 : 6, minHeight: chip ? 24 : 28, backgroundColor: fill, paddingLeft: chip ? 8 : 10, paddingRight: chip ? 8 : 10, borderWidth: variant === 'outline' ? 1 : 0, borderColor: t.border, borderRadius: chip ? 8 : 8, opacity: disabled ? 0.64 : 1, cursor: disabled ? 'default' : 'pointer', flexShrink: 0, hover: { backgroundColor: hover }, active: { backgroundColor: variant === 'primary' ? t.buttonPrimary : variant === 'destructive' ? t.red : t.buttonSecondaryHover } }}>{busy && <MatrixLoader dot={2} gap={1.33} rgb={variant === 'primary' ? (t.variant === 'dark' ? [13, 13, 13] : [252, 252, 252]) : undefined} alpha={0.7} />}{icon && <Icon source={icon} size={chip ? 12 : 14} color={color} style={{ pointerEvents: 'none' }} />}<Label color={color} size={chip ? text : 14} lineHeight={chip ? text * 1.5 : 21}>{children}</Label></div>
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
  return <PickerMenu open={open} testId={testId} disabled={disabled} side="bottom" align="end" minWidth={190} onOpenChange={(next) => { setOpen(next); setQuery('') }} trigger={() => <div aria-label={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: compact ? 6 : 12, minWidth: compact ? 96 : 144, maxWidth: 248, height: 28, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingLeft: 10, paddingRight: 8, opacity: disabled ? 0.45 : 1, hover: { backgroundColor: t.hover } }}><div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1 }}>{current?.mark && <ProviderMark kind={current.mark} size={12} />}<Label color={t.text} size={14} lineHeight={21} truncate>{current?.label ?? value}</Label></div><Chevron open={open} source={N.chevronDown} turn={180} duration={0.25} size={12} color={t.iconSecondary} /></div>}>
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
    <SlidingPill x={index * width} width={width} equal instant={keyboard} color={t.surface} />
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
  // The unit dims over 150 ms when the field turns off (0 with a 0 minimum).
  const dim = fadeTo(value === 0 && min === 0 ? 0.4 : 1)
  if (value !== adopted) { setAdopted(value); setDraft(value===0&&min===0?'':String(value)) }
  const commit = (text: string) => {
    if (disabled) return
    const next = text.trim() === '' ? (min === 0 ? 0 : value) : Number(text)
    if (!Number.isFinite(next)) { setDraft(value===0&&min===0?'':String(value)); return }
    const bounded = Math.min(max, Math.max(min, Math.round(next)))
    setDraft(bounded===0&&min===0?'':String(bounded))
    if (bounded !== value) onCommit(bounded)
  }
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><TextField testId={testId} label={label} placeholder={min===0?'Off':undefined} value={draft} onChange={setDraft} width={72} style={{fontSize:14,backgroundColor:t.variant === 'dark' ? ink(t,.016) : t.v('--background'),borderColor:ink(t,t.variant === 'dark' ? .05 : .06)}} readOnly={disabled} onBlur={() => commit(draft)} onSubmit={() => commit(draft)} onKeyDown={(e) => { if (e.key === 'enter') commit(draft); if (e.key === 'escape') setDraft(value===0&&min===0?'':String(value)); if (e.key === 'up' || e.key === 'down') commit(String((Number(draft) || 0) + (e.key === 'up' ? 1 : -1) * step * (e.modifiers?.shift ? 10 : 1))) }} /><div paintTransform={dim.paintTransform} style={{ display: 'flex', width: 44, ...dim.style }}><Label color={t.textSecondary} size={12}>{unit}</Label></div></div>
}

/**
 * The settings sections that rise in when a pointer switches tab (`settings-section-in`: 250 ms from 6 px). `SettingsScreen` provides it
 * for the tab it just opened; only the first section of the tab (with the heading) plays it, so a page never blurs more than two blocks.
 */
export const SectionEnter = createContext<{ play: boolean; next: () => number } | null>(null)

export function PageBlock({ children, enter }: { children: ReactNode; enter?: PaintTransformProps }) {
  return <div paintTransform={enter} style={{ display: 'flex', justifyContent: 'center', width: '100%', paddingLeft: 40, paddingRight: 40 }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 680 }}>{children}</div></div>
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme()
  const rows = Children.toArray(children)
  const entry = useContext(SectionEnter)
  const [first] = useState(() => !!entry?.play && entry.next() === 0)
  return <PageBlock enter={first ? enterTransform('section') : undefined}><div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 30 }}><Label color={t.text} size={14} lineHeight={19.6} weight={600} style={{ paddingLeft: 2 }}>{title}</Label><div style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.v('--app-settings-card-border'), borderRadius: 12, backgroundColor: t.v('--app-settings-card-surface'), overflow: 'hidden' }}>{rows.map((row, i) => <div key={i} style={{ borderTopWidth: i ? 1 : 0, borderColor: t.v('--app-settings-card-border') }}>{row}</div>)}</div></div></PageBlock>
}

export function Row({ title, description, status, children }: { title: string; description?: ReactNode; status?: string; children?: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, paddingLeft: 18, paddingRight: 18, paddingTop: 16, paddingBottom: 16 }}><div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, minWidth: 0 }}>{title && <Label color={t.text} size={14} lineHeight={21} weight={500}>{title}</Label>}{description && (typeof description === 'string' ? <SwapOnChange active={description} style={{ justifyContent: 'flex-start', alignItems: 'flex-start' }} innerStyle={{ alignItems: 'flex-start' }}><Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451 }}>{description}</Label></SwapOnChange> : description)}{status && <SwapOnChange active={status} style={{ justifyContent: 'flex-start', alignItems: 'flex-start' }} innerStyle={{ alignItems: 'flex-start' }}><Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451, paddingTop: 4 }}>{status}</Label></SwapOnChange>}</div>{children && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{children}</div>}</div>
}
