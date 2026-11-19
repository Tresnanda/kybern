
import type { PaintTransformProps } from '@gpuix/native/host'
import type { PublicInstance } from '@gpuix/react'
import { Children, createContext, isValidElement, useContext, useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { PickerMenu, PickerItem, CheckMark } from '../composer/Menu.tsx'



import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { useControls } from '../kit/controls.ts'
import { settingsCardStyle, useGlass } from '../platform/glass.ts'



import { SwapOnChange, enterTransform } from '../motion/kit.tsx'


import { SearchField } from '../kit/SearchField.tsx'
import { SharedMark } from './Mixed.tsx'
import { SelectTrigger } from '../kit/SelectTrigger.tsx'
import { EASE } from '../motion/tokens.ts'
import { land, revealHeader, SettingsList, useLanding, type SettingsSectionId } from './anchor.ts'
import { useGpuix } from '@gpuix/react'

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
 * desktop). `SettingsScreen` provides it for the tab it just opened. The heading and the first block (a `Section`, whose title and rows
 * all take its entrance, or a custom block such as Appearance's theme picker) clear a 2 px blur; later blocks rise without one.
 */
export const SectionEnter = createContext<{ play: boolean; next: () => number } | null>(null)

function blockEnter(index: number): PaintTransformProps | undefined {
  const rise = enterTransform('section')
  if (!rise || index === 0 || typeof rise.initial !== 'object' || !rise.animate) return rise
  const { blur: _initial, ...initial } = rise.initial
  const { blur: _animate, ...animate } = rise.animate
  return { ...rise, initial, animate }
}

export function PageBlock({ children, enter, testId, blockRef }: { children: ReactNode; enter?: PaintTransformProps; testId?: string; blockRef?: Ref<PublicInstance> }) {
  const entry = useContext(SectionEnter)
  const [index] = useState(() => (entry?.play ? entry.next() : -1))
  return <div ref={blockRef} testId={testId} paintTransform={enter ?? (index >= 0 ? blockEnter(index) : undefined)} style={{ display: 'flex', justifyContent: 'center', width: '100%', paddingLeft: 40, paddingRight: 40 }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 680 }}>{children}</div></div>
}

/**
 * A titled card of rows. Its title and each row are separate blocks (a fragment), so inside the Settings `virtual-list`
 * every row is its own list item: the list anchors on a small row instead of a whole section, and a row that changes
 * height moves only what is below it. The card is drawn per row (the first row carries the top edge and corners, the
 * last the bottom ones, every later row its divider), which paints the same as one card in any column. Rows keep their
 * own React keys, so a conditional row never remounts the rows after it.
 *
 * `id` makes the section a link target (`openSettings({ tab, section })`, `anchor.ts`): it lands at the top of the page
 * and its card is tinted once, briefly.
 */
export function Section({ id, title, accessory, children }: { id?: SettingsSectionId; title: string; /** Right-aligned on the title line (a status and a button). */ accessory?: ReactNode; children: ReactNode }) {
  const t = useTheme()
  const c = useControls()
  const g = useGlass()
  const rows = Children.toArray(children)
  const header = useRef<PublicInstance>(null)
  // One entrance for the whole section, as when it was a single block.
  const entry = useContext(SectionEnter)
  const [enterIndex] = useState(() => (entry?.play ? entry.next() : -1))
  const enter = enterIndex >= 0 ? blockEnter(enterIndex) : undefined
  const { aimed, lit } = useLanding(id)
  const [tinted, setTinted] = useState(false)
  if (lit && !tinted) setTinted(true)
  const list = useContext(SettingsList)
  const { renderer } = useGpuix()
  useEffect(() => { if (aimed && id && renderer) land(id, () => revealHeader(renderer, list, header)) }, [aimed, id, renderer, list])
  const { borderWidth: _border, borderRadius: _radius, ...card } = settingsCardStyle(t, g)
  const base = id ?? title
  const segments = rows.length ? rows : [null]
  return <>
    <PageBlock key={`${base}:title`} enter={enter} testId={id ? `settings-section-${id}` : undefined} blockRef={header}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 24, marginBottom: 12 }}><Label color={t.text} size={14} lineHeight={19.6} weight={600} style={{ paddingLeft: 2 }}>{title}</Label>{accessory && <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{accessory}</div>}</div></PageBlock>
    {segments.map((row, i) => {
      const first = i === 0
      const last = i === segments.length - 1
      const corners = { borderTopLeftRadius: first ? 12 : 0, borderTopRightRadius: first ? 12 : 0, borderBottomLeftRadius: last ? 12 : 0, borderBottomRightRadius: last ? 12 : 0 }
      return <PageBlock key={`${base}:${isValidElement(row) && row.key != null ? row.key : i}`} enter={enter}><div style={{ display: 'flex', flexDirection: 'column', paddingBottom: last ? 30 : 0 }}>
        <div style={{ ...card, ...corners, borderLeftWidth: 1, borderRightWidth: 1, borderTopWidth: 1, borderBottomWidth: last ? 1 : 0, ...(t.scope === 'none' ? { overflow: 'hidden' as const } : {}) }}>
          {first && <GlassEdge radius={12} color={g.highlight} />}
          {row}
          {tinted && <div paintTransform={{ initial: { opacity: 0 }, animate: { opacity: lit ? 1 : 0 }, transition: { duration: lit ? 0.2 : 0.4, ease: [...EASE.out] } }} style={{ position: 'absolute', left: 1, right: 1, top: 1, bottom: last ? 1 : 0, ...insetCorners(corners), backgroundColor: c.optionSelected, pointerEvents: 'none' }} />}
        </div>
      </div></PageBlock>
    })}
  </>
}

/** The radii just inside the 1 px border (absolute children are placed against the border box). */
const insetCorners = (corners: Record<string, number>) => Object.fromEntries(Object.entries(corners).map(([key, radius]) => [key, Math.max(0, radius - 1)]))

/** `shared`: the path of a setting the machines of a network share (`default_provider`); a Mixed marker or a waiting note shows before the control.
 * `mark`: an agent's mark (14px) before the title, for a row per agent. */
export function Row({ title, description, status, shared, mark, children }: { title: string; description?: ReactNode; status?: string; shared?: string; mark?: string; children?: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, paddingLeft: 18, paddingRight: 18, paddingTop: 16, paddingBottom: 16 }}><div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{title && (mark ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}><ProviderMark kind={mark} size={14} /><Label color={t.text} size={14} lineHeight={21} weight={500} truncate>{title}</Label></div> : <Label color={t.text} size={14} lineHeight={21} weight={500}>{title}</Label>)}{description && (typeof description === 'string' ? <SwapOnChange active={description} style={{ justifyContent: 'flex-start', alignItems: 'flex-start', minWidth: 0, flexShrink: 1, width: '100%' }} innerStyle={{ alignItems: 'flex-start', justifyContent: 'flex-start', width: '100%' }}><Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451, width: '100%' }}>{description}</Label></SwapOnChange> : description)}{status && <SwapOnChange active={status} style={{ justifyContent: 'flex-start', alignItems: 'flex-start', minWidth: 0, flexShrink: 1, width: '100%' }} innerStyle={{ alignItems: 'flex-start', justifyContent: 'flex-start', width: '100%' }}><Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451, width: '100%', paddingTop: 4 }}>{status}</Label></SwapOnChange>}</div>{(children || shared) && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{shared && <SharedMark path={shared} />}{children}</div>}</div>
}
