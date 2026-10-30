
import type { PaintTransformProps } from '@gpuix/native/host'
import { Children, createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { PickerMenu, PickerItem, CheckMark } from '../composer/Menu.tsx'



import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { raisedRim, settingsCardStyle, useGlass } from '../platform/glass.ts'



import { SwapOnChange, enterTransform } from '../motion/kit.tsx'


import { SearchField } from '../kit/SearchField.tsx'
import { SharedMark } from './Mixed.tsx'
import { SelectTrigger } from '../kit/SelectTrigger.tsx'

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
  return <PickerMenu open={open} testId={testId} disabled={disabled} side="bottom" align="end" minWidth={190} onOpenChange={(next) => { setOpen(next); setQuery('') }} trigger={() => <SelectTrigger label={label} mark={current?.mark} open={open} disabled={disabled} minWidth={compact ? 96 : 144} maxWidth={248}>{current?.label ?? value}</SelectTrigger>}>
    {options.length > 10 && <SearchField label={`Search ${label}`} value={query} onChange={setQuery} width={230} />}
    <virtual-list style={{ width: 250, height: Math.max(28, Math.min(filtered.length, 9) * 28) }}>
      {filtered.map((option) => <PickerItem key={option.value} id={option.value} testId={testId ? `${testId}-${option.value}` : undefined} disabled={option.disabled} onSelect={() => onChange(option.value)} style={{ height: 28 }}>{option.mark && <ProviderMark kind={option.mark} size={12} />}<Label color={t.text} size={12} truncate style={{ flexGrow: 1 }}>{option.label}</Label><CheckMark color={t.text} visible={option.value === value} /></PickerItem>)}
    </virtual-list>
  </PickerMenu>
}

/**
 * The settings blocks that rise in when a pointer switches tab (`settings-section-in`: 250 ms from 6 px, the whole section list like the
 * desktop). `SettingsScreen` provides it for the tab it just opened. The heading and the first block (a `Section` or a custom block such
 * as Appearance's theme picker) clear a 2 px blur; later blocks rise without one, so a tab never runs more than two blur passes.
 */
export const SectionEnter = createContext<{ play: boolean; next: () => number } | null>(null)

function blockEnter(index: number): PaintTransformProps | undefined {
  const rise = enterTransform('section')
  if (!rise || index === 0 || typeof rise.initial !== 'object' || !rise.animate) return rise
  const { blur: _initial, ...initial } = rise.initial
  const { blur: _animate, ...animate } = rise.animate
  return { ...rise, initial, animate }
}

export function PageBlock({ children, enter }: { children: ReactNode; enter?: PaintTransformProps }) {
  const entry = useContext(SectionEnter)
  const [index] = useState(() => (entry?.play ? entry.next() : -1))
  return <div paintTransform={enter ?? (index >= 0 ? blockEnter(index) : undefined)} style={{ display: 'flex', justifyContent: 'center', width: '100%', paddingLeft: 40, paddingRight: 40 }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 680 }}>{children}</div></div>
}

export function Section({ title, accessory, children }: { title: string; /** Right-aligned on the title line (a status and a button). */ accessory?: ReactNode; children: ReactNode }) {
  const t = useTheme()
  const g = useGlass()
  const rows = Children.toArray(children)
  return <PageBlock><div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 30 }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 24 }}><Label color={t.text} size={14} lineHeight={19.6} weight={600} style={{ paddingLeft: 2 }}>{title}</Label>{accessory && <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{accessory}</div>}</div><div style={{ display: 'flex', flexDirection: 'column', ...settingsCardStyle(t, g), ...(t.scope === 'none' ? { overflow: 'hidden' as const } : {}) }}><GlassEdge radius={12} color={g.highlight} />{rows.map((row, i) => <div key={i} style={{ borderTopWidth: i ? 1 : 0, borderColor: raisedRim(g, t.glass.settingsCardBorder) }}>{row}</div>)}</div></div></PageBlock>
}

/** `shared`: the path of a setting the machines of a network share (`default_provider`); a Mixed marker or a waiting note shows before the control. */
export function Row({ title, description, status, shared, children }: { title: string; description?: ReactNode; status?: string; shared?: string; children?: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, paddingLeft: 18, paddingRight: 18, paddingTop: 16, paddingBottom: 16 }}><div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{title && <Label color={t.text} size={14} lineHeight={21} weight={500}>{title}</Label>}{description && (typeof description === 'string' ? <SwapOnChange active={description} style={{ justifyContent: 'flex-start', alignItems: 'flex-start', minWidth: 0, flexShrink: 1, width: '100%' }} innerStyle={{ alignItems: 'flex-start', justifyContent: 'flex-start', width: '100%' }}><Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451, width: '100%' }}>{description}</Label></SwapOnChange> : description)}{status && <SwapOnChange active={status} style={{ justifyContent: 'flex-start', alignItems: 'flex-start', minWidth: 0, flexShrink: 1, width: '100%' }} innerStyle={{ alignItems: 'flex-start', justifyContent: 'flex-start', width: '100%' }}><Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451, width: '100%', paddingTop: 4 }}>{status}</Label></SwapOnChange>}</div>{(children || shared) && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{shared && <SharedMark path={shared} />}{children}</div>}</div>
}
