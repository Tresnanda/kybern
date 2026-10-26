// Settings › Appearance (desktop `SettingsScreen.tsx` `Appearance`): the three theme cards, then the window
// material of each theme variant (`platform/translucency.ts`): Solid or Translucent, Sidebar only, and an Advanced
// section with Sidebar opacity, Content opacity, Surface opacity and Blur. The variant in use comes first. Everything
// applies live: the theme re-themes the app and the window, and the sliders preview while held and save on release
// (`settings/appearance.ts`).
import { useRef, useState } from 'react'
import type { PaintTransformProps } from '@gpuix/native/host'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Chevron } from '../motion/Chevron.tsx'
import { enterTransform } from '../motion/kit.tsx'
import { PageBlock, Row, Section } from './controls.tsx'
import { Button } from '../kit/Button.tsx'
import { useControls } from '../kit/controls.ts'
import { Segmented } from '../kit/Segmented.tsx'
import { Slider } from '../kit/Slider.tsx'
import { FocusRing, Switch, useFocusRing } from '../kit/Switch.tsx'
import { useAccessibilityDisplay } from '../platform/material.ts'
import { raisedFill, useGlass } from '../platform/glass.ts'
import {
  BLUR_MAX, BLUR_MIN, OPACITY_MIN, SURFACE_DEFAULT, SURFACE_MIN, VIBRANCY_EQUIVALENT_BLUR, advancedDefaults, isAdvancedDefault, isSidebarOnly, type ThemeVariant,
} from '../platform/translucency.ts'
import { useBlurUnavailable } from '../shell/windowMaterial.ts'
import { DESKTOP_MATERIAL } from '../platform/desktopMaterial.ts'
import { previewWindowMaterial, setAppearance, setWindowMaterial, useAppearance } from './appearance.ts'

const WINDOW_OPTIONS = [{ value: 'solid', label: 'Solid' }, { value: 'translucent', label: 'Translucent' }] as const
const PREVIEW_MS = 100
/** Whether each variant's Advanced section is open: kept while the app runs, not saved. */
const advancedOpen: Partial<Record<ThemeVariant, boolean>> = {}

/** A slider's live value and its throttled preview: the label follows every move, the theme at most ten times a second. */
function useLiveValue(preview: (value: number) => void, commit: (value: number) => void) {
  const [live, setLive] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<number | null>(null)
  return {
    live,
    onChange: (value: number) => {
      setLive(value)
      pending.current = value
      timer.current ??= setTimeout(() => { timer.current = undefined; if (pending.current !== null) preview(pending.current) }, PREVIEW_MS)
    },
    onCommit: (value: number) => {
      clearTimeout(timer.current)
      timer.current = undefined
      pending.current = null
      setLive(null)
      commit(value)
    },
  }
}

/** The disclosed rows rise in when a pointer turns Translucent on, without a blur; Reduce Motion shows them at once. */
function discloseTransform(): PaintTransformProps | undefined {
  const rise = enterTransform('section')
  if (REDUCED_MOTION || !rise || typeof rise.initial !== 'object' || !rise.animate) return undefined
  const { blur: _initial, ...initial } = rise.initial
  const { blur: _animate, ...animate } = rise.animate
  return { ...rise, initial, animate }
}

/** The Advanced row: a full-width button with a chevron, the name, and while closed a one-line summary. */
function AdvancedRow({ open, summary, label, testId, onToggle }: { open: boolean; summary: string; label: string; testId: string; onToggle: () => void }) {
  const t = useTheme()
  const hoverFill = raisedFill(useGlass(), t.hover, true)
  const focus = useFocusRing()
  const [hover, setHover] = useState(false)
  return <div testId={testId} role="button" tabIndex={0} aria-label={label} aria-expanded={open} onClick={onToggle}
    onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') { focus.keyed(); onToggle() } }}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    onMouseDown={focus.handlers.onMouseDown} onFocus={focus.handlers.onFocus} onBlur={focus.handlers.onBlur}
    style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, height: 44, paddingLeft: 18, paddingRight: 18, cursor: 'pointer', backgroundColor: hover ? hoverFill : 'transparent', borderRadius: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Chevron open={open} size={12} color={t.iconSecondary} />
      <Label color={t.text} size={14} weight={500}>Advanced</Label>
    </div>
    {!open && <Label color={t.textSecondary} size={13}>{summary}</Label>}
    <FocusRing visible={focus.visible} radius={0} width={2} offset={-2} color={t.v('--ring')} />
  </div>
}

function VariantSection({ variant, active, save }: { variant: ThemeVariant; active: boolean; save: (apply: () => void) => void }) {
  const t = useTheme()
  const prefs = useAppearance()
  const a11y = useAccessibilityDisplay()
  const unavailable = useBlurUnavailable()
  const m = prefs.window[variant]
  const [disclose, setDisclose] = useState(false)
  const [open, setOpen] = useState(() => advancedOpen[variant] ?? !isAdvancedDefault(m, variant))
  const Name = variant === 'dark' ? 'Dark' : 'Light'
  const lower = variant
  const patch = (next: Parameters<typeof setWindowMaterial>[1]) => save(() => setWindowMaterial(variant, next))
  const sidebar = useLiveValue((value) => previewWindowMaterial(variant, { sidebarOpacity: value }), (value) => patch({ sidebarOpacity: value }))
  const content = useLiveValue((value) => previewWindowMaterial(variant, { contentOpacity: value }), (value) => patch({ contentOpacity: value }))
  const surface = useLiveValue((value) => previewWindowMaterial(variant, { surfaceOpacity: value }), (value) => patch({ surfaceOpacity: value }))
  const blur = useLiveValue((value) => previewWindowMaterial(variant, { blur: value }), (value) => patch({ blur: value }))
  const sidebarValue = sidebar.live ?? m.sidebarOpacity
  const contentValue = content.live ?? m.contentOpacity
  const surfaceValue = surface.live ?? m.surfaceOpacity ?? SURFACE_DEFAULT[variant]
  const blurValue = blur.live ?? m.blur
  // The Sidebar only switch follows the content slider live, from the value being previewed.
  const sidebarOnly = isSidebarOnly({ contentOpacity: contentValue })
  const rise = disclose ? discloseTransform() : undefined
  const translucent = m.material === 'translucent'
  const toggleAdvanced = () => { advancedOpen[variant] = !open; setOpen(!open) }
  const advanced = open ? discloseTransform() : undefined

  const status = !active ? undefined
    : a11y.reduceTransparency && a11y.increaseContrast ? 'Reduce transparency and Increase contrast are on in System Settings, so Kybern stays solid.'
    : a11y.reduceTransparency ? 'Reduce transparency is on in System Settings, so Kybern stays solid.'
    : a11y.increaseContrast ? 'Increase contrast is on in System Settings, so Kybern stays solid.'
    : undefined
  const inactive = prefs.theme === 'system' ? `Used when your system switches to ${variant}` : variant === 'dark' ? 'Used when you choose Dark or System' : 'Used when you choose Light or System'
  const accessory = active ? <Label color={t.textSecondary} size={13} lineHeight={18}>In use now</Label>
    : <><Label color={t.textSecondary} size={13} lineHeight={18}>{inactive}</Label><Button variant="secondary" size="sm" testId={`settings-use-${variant}`} onClick={() => save(() => setAppearance({ theme: variant }))}>{`Use ${variant} theme`}</Button></>
  const summary = `Sidebar ${m.sidebarOpacity}% · Content ${m.contentOpacity}% · Surface ${m.surfaceOpacity ?? SURFACE_DEFAULT[variant]}% · Blur ${m.blur === null ? 'Auto' : m.blur}`

  return <Section title={`${Name} theme`} accessory={accessory}>
    <Row title="Window" description={DESKTOP_MATERIAL === 'none' ? 'Translucent turns the sidebar, menus and composer to glass. On this system the window itself stays solid.' : 'Translucent lets your desktop show through Kybern.'} status={status}>
      <Segmented testId={`settings-window-${variant}`} aria-label={`${Name} theme window material`} options={WINDOW_OPTIONS} value={m.material} onChange={(material) => { setDisclose(true); patch({ material: material as typeof m.material }) }} />
    </Row>
    {translucent && <div key="sidebar" paintTransform={rise}><Row title="Sidebar only" description="Keep the conversation solid. Only the sidebar and window frame are translucent.">
      <Switch aria-label={`${Name} theme translucent sidebar only`} testId={`settings-sidebar-only-${variant}`} checked={sidebarOnly} onCheckedChange={(next) => patch({ sidebarOnly: next })} />
    </Row></div>}
    {translucent && <div key="advanced" paintTransform={rise}><AdvancedRow testId={`settings-advanced-${variant}`} open={open} summary={summary} label={`${Name} theme advanced window settings`} onToggle={toggleAdvanced} /></div>}
    {translucent && open && <div key="sidebar-opacity" paintTransform={advanced}><Row title="Sidebar opacity" description="How much color covers your desktop behind the sidebar and window frame. Very low values stop where text stays readable.">
      <Slider testId={`settings-sidebar-opacity-${variant}`} aria-label={`${Name} theme sidebar opacity`} ariaValueText={`${sidebarValue} percent`} value={sidebarValue} min={OPACITY_MIN} max={100} valueLabel={`${sidebarValue}%`} onChange={sidebar.onChange} onCommit={sidebar.onCommit} />
    </Row></div>}
    {translucent && open && <div key="content-opacity" paintTransform={advanced}><Row title="Content opacity" description="How much color covers your desktop behind the conversation. At 100%, only the sidebar is translucent.">
      <Slider testId={`settings-content-opacity-${variant}`} aria-label={`${Name} theme content opacity`} ariaValueText={`${contentValue} percent`} value={contentValue} min={OPACITY_MIN} max={100} valueLabel={`${contentValue}%`} onChange={content.onChange} onCommit={content.onCommit} />
    </Row></div>}
    {translucent && open && <div key="surface-opacity" paintTransform={advanced}><Row title="Surface opacity" description="How solid the composer, menus and cards are on glass. Applies once content opacity is below 100%.">
      <Slider testId={`settings-surface-opacity-${variant}`} aria-label={`${Name} theme surface opacity`} ariaValueText={`${surfaceValue} percent`} value={surfaceValue} min={SURFACE_MIN} max={100} valueLabel={`${surfaceValue}%`} onChange={surface.onChange} onCommit={surface.onCommit} />
    </Row></div>}
    {translucent && open && DESKTOP_MATERIAL !== 'none' && <div key="blur" paintTransform={advanced}><Row title="Blur" description={DESKTOP_MATERIAL === 'dwm' ? 'Auto uses Mica. Any other value uses Acrylic, which also blurs the windows behind Kybern; Windows sets its strength.' : 'How much your desktop is blurred behind the whole window. Auto uses the macOS material.'}>
      {m.blur !== null && <Button variant="secondary" size="sm" testId={`settings-blur-auto-${variant}`} label={`${Name} theme automatic blur`} onClick={() => patch({ blur: null })}>{active && unavailable ? 'Unavailable, use Auto' : 'Auto'}</Button>}
      <Slider testId={`settings-blur-${variant}`} aria-label={`${Name} theme blur`} ariaValueText={blurValue === null ? 'Automatic' : `${blurValue} points`} value={blurValue ?? VIBRANCY_EQUIVALENT_BLUR} min={BLUR_MIN} max={BLUR_MAX} muted={blurValue === null} valueLabel={blurValue === null ? 'Auto' : String(blurValue)} onChange={blur.onChange} onCommit={blur.onCommit} />
    </Row></div>}
    {translucent && open && <div key="reset" paintTransform={advanced} style={{ display: 'flex', justifyContent: 'flex-end', paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 12 }}>
      <Button variant="ghost" size="sm" testId={`settings-reset-${variant}`} label={`Reset ${lower} theme window settings to defaults`} disabled={isAdvancedDefault({ ...m, contentOpacity: contentValue }, variant)} onClick={() => patch(advancedDefaults(m))}>Reset to defaults</Button>
    </div>}
  </Section>
}

export function Appearance() {
  const t = useTheme()
  const c = useControls()
  const prefs = useAppearance()
  const [error, setError] = useState('')
  // `apply` is a `setAppearance` / `setWindowMaterial` call; both throw when the file cannot be written.
  const run = (apply: () => void) => { try { apply(); setError('') } catch (e) { setError(`Unable to save appearance. ${String(e)}`) } }
  const save = (patch: Parameters<typeof setAppearance>[0]) => run(() => setAppearance(patch))
  const order: ThemeVariant[] = t.variant === 'dark' ? ['dark', 'light'] : ['light', 'dark']
  return <>
    <PageBlock><div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 30 }}><Label color={t.text} size={14} lineHeight={19.6} weight={600}>Theme</Label>
      <div style={{ display: 'flex', gap: 14 }}>{(['light', 'dark', 'system'] as const).map((value) => {
        const preview = { frame: value === 'dark' ? '#202023' : '#f7f7f8', text: value === 'system' ? '#929299' : value === 'dark' ? '#ededf0' : '#27272a' }
        return <div key={value} testId={`settings-theme-${value}`} tabIndex={0} aria-label={`${value} theme`} aria-pressed={prefs.theme === value} onClick={() => save({ theme: value })} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') save({ theme: value }) }} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexBasis: 0, minWidth: 0, cursor: 'pointer' }}>
          <div style={{ display: 'flex', pointerEvents: 'none', height: 112, borderWidth: 1, borderColor: prefs.theme === value ? c.accent : t.border, ...(prefs.theme === value ? { boxShadow: { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 2, color: c.acc(0.3) } } : {}), borderRadius: 10, padding: 10, ...(value === 'system' ? { background: { type: 'linear-gradient' as const, angle: 110, stops: [{ color: '#f7f7f8', position: 0.499 }, { color: '#202023', position: 0.501 }] } } : { backgroundColor: preview.frame }) }}>
            <div style={{ display: 'flex', flexDirection: 'column', pointerEvents: 'none', width: '28%', paddingTop: 14, paddingRight: 7, gap: 9, borderRightWidth: 1, borderColor: preview.text, opacity: 0.25 }}>{[0, 1, 2].map((i) => <div key={i} style={{ pointerEvents: 'none', height: 4, borderRadius: 3, backgroundColor: preview.text }} />)}</div>
            <div style={{ display: 'flex', flexDirection: 'column', pointerEvents: 'none', flexGrow: 1, paddingTop: 16, paddingLeft: 12 }}>
              <div style={{ width: '48%', height: 4, borderRadius: 2, backgroundColor: preview.text, opacity: 0.6, marginBottom: 7 }} />
              <div style={{ width: '76%', height: 4, borderRadius: 2, backgroundColor: preview.text, opacity: 0.25, marginBottom: 7 }} />
              <div style={{ height: 24, borderWidth: 1, borderColor: preview.text, borderRadius: 4, opacity: 0.15, marginTop: 5, marginBottom: 12 }} />
              <div style={{ width: '76%', height: 4, borderRadius: 2, backgroundColor: preview.text, opacity: 0.25 }} />
            </div>
          </div><div style={{ display: 'flex', pointerEvents: 'none', gap: 7, paddingTop: 13, alignItems: 'center' }}><Icon source={value === 'system' ? N.laptop : value === 'dark' ? N.moon : N.sun} size={16} color={prefs.theme === value ? c.accentFg : t.text} /><Label color={prefs.theme === value ? c.accentFg : t.text} size={13} weight={prefs.theme === value ? 600 : undefined}>{value[0].toUpperCase() + value.slice(1)}</Label></div>
        </div>
      })}</div>
      <Label color={t.textSecondary} size={12} lineHeight={19.2}>System follows your device’s light and dark appearance.</Label>
    </div></PageBlock>
    {order.map((variant) => <VariantSection key={variant} variant={variant} active={variant === t.variant} save={run} />)}
    {error && <Label color={t.red}>{error}</Label>}
  </>
}
