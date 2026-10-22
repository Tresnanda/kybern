// Settings › Appearance (desktop `SettingsScreen.tsx` `Appearance`): the three theme cards, then the window
// material of each theme variant (`platform/translucency.ts`): Solid or Translucent, Sidebar only, Opacity and
// Blur. The variant in use comes first. Everything applies live: the theme re-themes the app and the window,
// and the sliders preview while held and save on release (`settings/appearance.ts`).
import { useRef, useState } from 'react'
import type { PaintTransformProps } from '@gpuix/native/host'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { enterTransform } from '../motion/kit.tsx'
import { Button, PageBlock, Row, Section } from './controls.tsx'
import { Segmented } from '../kit/Segmented.tsx'
import { Slider } from '../kit/Slider.tsx'
import { Switch } from '../kit/Switch.tsx'
import { useAccessibilityDisplay } from '../platform/material.ts'
import { BLUR_MAX, BLUR_MIN, OPACITY_MIN, VIBRANCY_EQUIVALENT_BLUR, type ThemeVariant } from '../platform/translucency.ts'
import { useBlurUnavailable } from '../shell/windowMaterial.ts'
import { previewWindowMaterial, setAppearance, setWindowMaterial, useAppearance } from './appearance.ts'

const WINDOW_OPTIONS = [{ value: 'solid', label: 'Solid' }, { value: 'translucent', label: 'Translucent' }] as const
const PREVIEW_MS = 100

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

function VariantSection({ variant, active, save }: { variant: ThemeVariant; active: boolean; save: (apply: () => void) => void }) {
  const t = useTheme()
  const prefs = useAppearance()
  const a11y = useAccessibilityDisplay()
  const unavailable = useBlurUnavailable()
  const m = prefs.window[variant]
  const [disclose, setDisclose] = useState(false)
  const Name = variant === 'dark' ? 'Dark' : 'Light'
  const patch = (next: Partial<typeof m>) => save(() => setWindowMaterial(variant, next))
  const opacity = useLiveValue((value) => previewWindowMaterial(variant, { opacity: value }), (value) => patch({ opacity: value }))
  const blur = useLiveValue((value) => previewWindowMaterial(variant, { blur: value }), (value) => patch({ blur: value }))
  const opacityValue = opacity.live ?? m.opacity
  const blurValue = blur.live ?? m.blur
  const rise = disclose ? discloseTransform() : undefined

  const status = !active ? undefined
    : a11y.reduceTransparency && a11y.increaseContrast ? 'Reduce transparency and Increase contrast are on in System Settings, so Kybern stays solid.'
    : a11y.reduceTransparency ? 'Reduce transparency is on in System Settings, so Kybern stays solid.'
    : a11y.increaseContrast ? 'Increase contrast is on in System Settings, so Kybern stays solid.'
    : undefined
  const inactive = prefs.theme === 'system' ? `Used when your system switches to ${variant}` : variant === 'dark' ? 'Used when you choose Dark or System' : 'Used when you choose Light or System'
  const accessory = active ? <Label color={t.textSecondary} size={13} lineHeight={18}>In use now</Label>
    : <><Label color={t.textSecondary} size={13} lineHeight={18}>{inactive}</Label><Button variant="outline" size="xs" testId={`settings-use-${variant}`} onClick={() => save(() => setAppearance({ theme: variant }))}>{`Use ${variant} theme`}</Button></>

  return <Section title={`${Name} theme`} accessory={accessory}>
    <Row title="Window" description="Translucent lets your desktop show through Kybern." status={status}>
      <Segmented testId={`settings-window-${variant}`} aria-label={`${Name} theme window material`} textSize={13} segmentPadX={10} options={WINDOW_OPTIONS} value={m.material} onChange={(material) => { setDisclose(true); patch({ material: material as typeof m.material }) }} />
    </Row>
    {m.material === 'translucent' && <div key="sidebar" paintTransform={rise}><Row title="Sidebar only" description="Keep the conversation solid. Only the sidebar and window frame are translucent.">
      <Switch aria-label={`${Name} theme translucent sidebar only`} testId={`settings-sidebar-only-${variant}`} checked={m.sidebarOnly} onCheckedChange={(sidebarOnly) => patch({ sidebarOnly })} />
    </Row></div>}
    {m.material === 'translucent' && <div key="opacity" paintTransform={rise}><Row title="Opacity" description="How much of the window’s color covers your desktop.">
      <Slider testId={`settings-opacity-${variant}`} aria-label={`${Name} theme opacity`} ariaValueText={`${opacityValue} percent`} value={opacityValue} min={OPACITY_MIN} max={100} valueLabel={`${opacityValue}%`} onChange={opacity.onChange} onCommit={opacity.onCommit} />
    </Row></div>}
    {m.material === 'translucent' && <div key="blur" paintTransform={rise}><Row title="Blur" description="How much your desktop is blurred. Auto uses the macOS material.">
      {m.blur !== null && <Button variant="outline" size="xs" testId={`settings-blur-auto-${variant}`} label={`${Name} theme automatic blur`} onClick={() => patch({ blur: null })}>{active && unavailable ? 'Unavailable, use Auto' : 'Auto'}</Button>}
      <Slider testId={`settings-blur-${variant}`} aria-label={`${Name} theme blur`} ariaValueText={blurValue === null ? 'Automatic' : `${blurValue} points`} value={blurValue ?? VIBRANCY_EQUIVALENT_BLUR} min={BLUR_MIN} max={BLUR_MAX} muted={blurValue === null} valueLabel={blurValue === null ? 'Auto' : String(blurValue)} onChange={blur.onChange} onCommit={blur.onCommit} />
    </Row></div>}
  </Section>
}

export function Appearance() {
  const t = useTheme()
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
          <div style={{ display: 'flex', pointerEvents: 'none', height: 112, borderWidth: 1, borderColor: prefs.theme === value ? 'transparent' : t.border, ...(prefs.theme === value ? { boxShadow: { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 2, color: t.text } } : {}), borderRadius: 10, padding: 10, ...(value === 'system' ? { background: { type: 'linear-gradient' as const, angle: 110, stops: [{ color: '#f7f7f8', position: 0.499 }, { color: '#202023', position: 0.501 }] } } : { backgroundColor: preview.frame }) }}>
            <div style={{ display: 'flex', flexDirection: 'column', pointerEvents: 'none', width: '28%', paddingTop: 14, paddingRight: 7, gap: 9, borderRightWidth: 1, borderColor: preview.text, opacity: 0.25 }}>{[0, 1, 2].map((i) => <div key={i} style={{ pointerEvents: 'none', height: 4, borderRadius: 3, backgroundColor: preview.text }} />)}</div>
            <div style={{ display: 'flex', flexDirection: 'column', pointerEvents: 'none', flexGrow: 1, paddingTop: 16, paddingLeft: 12 }}>
              <div style={{ width: '48%', height: 4, borderRadius: 2, backgroundColor: preview.text, opacity: 0.6, marginBottom: 7 }} />
              <div style={{ width: '76%', height: 4, borderRadius: 2, backgroundColor: preview.text, opacity: 0.25, marginBottom: 7 }} />
              <div style={{ height: 24, borderWidth: 1, borderColor: preview.text, borderRadius: 4, opacity: 0.15, marginTop: 5, marginBottom: 12 }} />
              <div style={{ width: '76%', height: 4, borderRadius: 2, backgroundColor: preview.text, opacity: 0.25 }} />
            </div>
          </div><div style={{ display: 'flex', pointerEvents: 'none', gap: 7, paddingTop: 13, alignItems: 'center' }}><Icon source={value === 'system' ? N.laptop : value === 'dark' ? N.moon : N.sun} size={16} color={t.text} /><Label color={t.text} size={13}>{value[0].toUpperCase() + value.slice(1)}</Label></div>
        </div>
      })}</div>
      <Label color={t.textSecondary} size={12} lineHeight={19.2}>System follows your device’s light and dark appearance.</Label>
    </div></PageBlock>
    {order.map((variant) => <VariantSection key={variant} variant={variant} active={variant === t.variant} save={run} />)}
    {error && <Label color={t.red}>{error}</Label>}
  </>
}
