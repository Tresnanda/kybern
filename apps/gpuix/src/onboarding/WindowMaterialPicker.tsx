// Preferences, left column, part 2 (SPEC §5): the window material. Three cards (Solid, Translucent sidebar, Full translucency), each a
// small window over a desktop whose sidebar, content and composer take their alpha from the option (alpha only, no backdrop
// blur); the selected card follows the sliders live. Under the cards a caption that swaps, and an Adjust disclosure with four
// sliders. Everything writes through the Settings path (`setWindowMaterial`, throttled `previewWindowMaterial` while dragging)
// for the active theme variant. Slider state is local to this picker, so a drag repaints this picker and nothing else.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useControls } from '../kit/controls.ts'
import { Slider } from '../kit/Slider.tsx'
import { Chevron } from '../motion/Chevron.tsx'
import { Collapse, Swap } from '../motion/kit.tsx'
import { DESKTOP_MATERIAL } from '../platform/desktopMaterial.ts'
import { useAccessibilityDisplay } from '../platform/material.ts'
import { DEFAULT_VARIANT_MATERIAL, OPACITY_MIN, SURFACE_DEFAULT, SURFACE_MIN, effectiveSurface, surfaceFloor, type ThemeVariant, type VariantMaterial } from '../platform/translucency.ts'
import { previewWindowMaterial, setWindowMaterial, useAppearance } from '../settings/appearance.ts'
import { toast } from '../shell/toasts.tsx'
import { THEMES } from '../theme.ts'
import { Label, REDUCED_MOTION, ink, useTheme } from '../ui.tsx'
import { CardGroup, type CardOption } from './AppearancePicker.tsx'
import { MATERIAL_CAPTION, MATERIAL_LABEL, blurFromPercent, blurPercent, materialPatch, materialSummary, optionOf, type MaterialOption } from './model.ts'
import { contentPatch, glideSteps, PREVIEW_RADIUS, SLIDER_KEYS, SLIDER_LABEL, type SliderKey, type SliderValues } from './prefsLayout.ts'
import { applyMaterialPatch } from './prefsModel.ts'
import { Roll } from './motion.tsx'

const OPTIONS: readonly CardOption<MaterialOption>[] = (['solid', 'sidebar', 'full'] as const).map((value) => ({ value, label: MATERIAL_LABEL[value], testId: `prefs-material-${value}` }))
const THROTTLE_MS = 100
const GLIDE_MS = 50
const GLIDE_STEPS = 10
const SLIDER_ROW = 32
const SLIDER_BOX = 212
/** The first time Full translucency is picked the disclosure opens by itself; after that it stays as the user left it. */
let openedOnce = false

// ─── What the sliders mean ────────────────────────────────────────────────

const floors: Partial<Record<ThemeVariant, number>> = {}
/** The readability floor of Elements: the slider cannot go under what the window would paint anyway. */
const floorOf = (variant: ThemeVariant) => (floors[variant] ??= Math.max(SURFACE_MIN, surfaceFloor(variant, THEMES[variant].raw)))
const elementsOf = (variant: ThemeVariant, surface: number | null) => effectiveSurface(variant, THEMES[variant].raw, surface ?? SURFACE_DEFAULT[variant])

const valuesOf = (variant: ThemeVariant, m: VariantMaterial): SliderValues => ({ sidebar: m.sidebarOpacity, content: m.contentOpacity, elements: elementsOf(variant, m.surfaceOpacity), blur: blurPercent(m.blur) })

function patchFor(key: SliderKey, value: number): Partial<VariantMaterial> {
  switch (key) {
    case 'sidebar': return { sidebarOpacity: value }
    case 'content': return contentPatch(value)
    case 'elements': return { surfaceOpacity: value }
    case 'blur': return { blur: blurFromPercent(value) }
  }
}

// ─── The window miniatures ────────────────────────────────────────────────

const PALETTE = {
  light: { desk: '#d9d4cc', sidebar: [244, 244, 244], content: [255, 255, 255], element: [255, 255, 255] },
  dark: { desk: '#2a2622', sidebar: [31, 31, 32], content: [24, 24, 24], element: [42, 42, 42] },
} as const
const rgba = (rgb: readonly number[], alpha: number) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`

export interface WindowMiniProps { variant: ThemeVariant; width: number; height: number; sidebar: number; content: number; elements: number; edge: string; bar: string }

/** A neutral desk (an orange, a blue and a pink shape, a white window behind) with a Kybern window over it. Alphas are percents. */
const WindowMini = memo(function WindowMini({ variant, width, height, sidebar, content, elements, edge, bar }: WindowMiniProps) {
  const p = PALETTE[variant]
  const sb = Math.round(width * 0.3)
  const inset = Math.round(width * 0.08)
  const top = Math.round(height * 0.14)
  const shape = (extra: object) => <div style={{ position: 'absolute', borderRadius: 999, ...extra }} />
  return (
    <div
      style={{
        position: 'relative', width, height, flexShrink: 0, borderRadius: PREVIEW_RADIUS, overflow: 'hidden', borderWidth: 1, borderColor: edge, backgroundColor: p.desk,
        boxShadow: { offsetX: 0, offsetY: 6, blurRadius: 14, spreadRadius: -8, color: 'rgba(0, 0, 0, 0.3)' },
      }}
    >
      {shape({ left: -Math.round(width * 0.04), top: Math.round(height * 0.22), width: Math.round(width * 0.4), height: Math.round(width * 0.4), backgroundColor: '#f2a65a' })}
      {shape({ right: Math.round(width * 0.02), top: Math.round(height * 0.18), width: Math.round(width * 0.4), height: Math.round(width * 0.4), backgroundColor: '#5b7cfa' })}
      {shape({ left: Math.round(width * 0.3), bottom: -Math.round(height * 0.16), width: Math.round(width * 0.26), height: Math.round(width * 0.26), backgroundColor: '#e8667a' })}
      <div style={{ position: 'absolute', left: Math.round(width * 0.34), top: Math.round(height * 0.16), width: Math.round(width * 0.38), height: Math.round(height * 0.26), borderRadius: 4, backgroundColor: '#ffffff', boxShadow: { offsetX: 0, offsetY: 2, blurRadius: 6, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.2)' } }} />
      <div
        style={{
          position: 'absolute', left: inset, right: inset, top, bottom: -10, display: 'flex', flexDirection: 'row', borderRadius: 7, overflow: 'hidden',
          boxShadow: [{ offsetX: 0, offsetY: 6, blurRadius: 18, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.25)' }, { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 0.5, color: 'rgba(0, 0, 0, 0.25)' }],
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', width: `${Math.round((sb / (width - inset * 2)) * 100)}%`, padding: 8, paddingLeft: 6, paddingRight: 6, gap: 4, backgroundColor: rgba(p.sidebar, sidebar / 100) }}>
          {['70%', '100%', '55%'].map((w) => <div key={w} style={{ width: w, height: 4, borderRadius: 2, backgroundColor: bar }} />)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexBasis: 0, padding: 10, paddingBottom: 18, gap: 4, backgroundColor: rgba(p.content, content / 100) }}>
          <div style={{ width: '70%', height: 4, borderRadius: 2, backgroundColor: bar }} />
          <div style={{ width: '45%', height: 4, borderRadius: 2, backgroundColor: bar }} />
          <div style={{ flexGrow: 1 }} />
          <div style={{ height: 16, borderRadius: 6, borderWidth: 1, borderColor: edge, backgroundColor: rgba(p.element, elements / 100) }} />
        </div>
      </div>
    </div>
  )
})

// ─── One slider ───────────────────────────────────────────────────────────

const SliderRow = memo(function SliderRow({ name, value, min, active, onChange, onCommit }: {
  name: SliderKey; value: number; min: number
  /** Dragging or gliding: the number follows quickly instead of rolling for 700 ms. */
  active: boolean
  onChange: (key: SliderKey, value: number) => void
  onCommit: (key: SliderKey, value: number) => void
}) {
  const t = useTheme()
  const label = SLIDER_LABEL[name]
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, height: SLIDER_ROW }}>
      <div style={{ display: 'flex', width: 72, flexShrink: 0 }}><Label color={t.textSecondary} size={13} lineHeight={18} weight={500}>{label}</Label></div>
      <div style={{ position: 'relative', display: 'flex', width: SLIDER_BOX, flexShrink: 0 }}>
        <Slider
          testId={`prefs-slider-${name}`}
          aria-label={label}
          ariaValueText={`${value} percent`}
          value={value}
          min={min}
          max={100}
          valueLabel={' '}
          onChange={(v) => onChange(name, v)}
          onCommit={(v) => onCommit(name, v)}
        />
        {/* The kit slider writes its number as plain text; the rolling one is laid over its value column. */}
        <div style={{ position: 'absolute', right: 0, top: 5, width: 40, display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', pointerEvents: 'none' }}>
          <Roll value={value} size={13} lineHeight={18} color={t.textTertiary} duration={active || REDUCED_MOTION ? 0.1 : 0.7} />
          <Label color={t.textTertiary} size={13} lineHeight={18}>%</Label>
        </div>
      </div>
    </div>
  )
})

// ─── The picker ───────────────────────────────────────────────────────────

export const WindowMaterialPicker = memo(function WindowMaterialPicker({ column, card, previewWidth, previewHeight }: { column: number; card: number; previewWidth: number; previewHeight: number }) {
  const t = useTheme()
  const c = useControls()
  const variant = t.variant
  const a11y = useAccessibilityDisplay()
  const m = useAppearance().window[variant]
  const [live, setLive] = useState<Partial<SliderValues>>({})
  const [open, setOpen] = useState(false)
  // 'drag': the Content slider decides the selection while it is held; 'glide': a pick is rolling the sliders to its values.
  const phase = useRef<'idle' | 'drag' | 'glide'>('idle')
  const timers = useRef<{ preview?: ReturnType<typeof setTimeout>; glide?: ReturnType<typeof setInterval> }>({})
  const pending = useRef<Partial<SliderValues>>({})
  const current = useRef({ variant, m })
  current.current = { variant, m }
  const showBlur = DESKTOP_MATERIAL === 'vibrancy'

  const stopGlide = () => { clearInterval(timers.current.glide); timers.current.glide = undefined; if (phase.current === 'glide') phase.current = 'idle' }
  // A write that fails leaves the saved material showing; say so once (a drag would otherwise toast on every release).
  const write = (apply: () => void) => { try { apply() } catch { toast.error('Couldn’t save the window style.', { id: 'onboarding-window-style', description: 'Change it in Settings › Appearance.' }) } }
  useEffect(() => () => { clearTimeout(timers.current.preview); clearInterval(timers.current.glide) }, [])

  const saved = valuesOf(variant, m)
  const shown: SliderValues = { ...saved, ...live }
  // Content below 100 is Full translucency while it is dragged; otherwise the saved material decides.
  const option: MaterialOption = optionOf({ material: m.material, contentOpacity: phase.current === 'drag' ? shown.content : m.contentOpacity })

  const flush = () => {
    timers.current.preview = undefined
    const batch = pending.current
    pending.current = {}
    const { variant: v } = current.current
    for (const key of SLIDER_KEYS) { const value = batch[key]; if (value !== undefined) write(() => previewWindowMaterial(v, patchFor(key, value))) }
  }
  const onChange = (key: SliderKey, value: number) => {
    stopGlide()
    phase.current = 'drag'
    setLive((old) => ({ ...old, [key]: value }))
    pending.current[key] = value
    timers.current.preview ??= setTimeout(flush, THROTTLE_MS)
  }
  const onCommit = (key: SliderKey, value: number) => {
    delete pending.current[key]
    if (!Object.keys(pending.current).length) { clearTimeout(timers.current.preview); timers.current.preview = undefined }
    write(() => setWindowMaterial(current.current.variant, patchFor(key, value)))
    phase.current = 'idle'
    setLive((old) => { const { [key]: _gone, ...rest } = old; return rest })
  }

  const pick = (next: MaterialOption, byPointer: boolean) => {
    const { variant: v, m: before } = current.current
    if (next === optionOf(before) && phase.current !== 'drag') return
    const from: SliderValues = { ...valuesOf(v, before), ...live }
    stopGlide()
    clearTimeout(timers.current.preview); timers.current.preview = undefined; pending.current = {}
    phase.current = 'idle'
    const patch = materialPatch(next)
    write(() => setWindowMaterial(v, patch))
    setLive({})
    if (next === 'solid') return
    if (next === 'full' && !openedOnce) { openedOnce = true; setOpen(true) }
    if (!byPointer || REDUCED_MOTION) return
    // A pointer pick glides the numbers to the option's values: a few eased steps, display only (the window already has them).
    const to = valuesOf(v, applyMaterialPatch(before, patch))
    const steps = glideSteps(from, to, GLIDE_STEPS)
    if (steps.length < 2 && SLIDER_KEYS.every((key) => from[key] === to[key])) return
    phase.current = 'glide'
    let i = 0
    setLive(from)
    timers.current.glide = setInterval(() => {
      const step = steps[i++]
      if (!step) { stopGlide(); setLive({}); return }
      setLive(step)
      if (i >= steps.length) { stopGlide(); setLive({}) }
    }, GLIDE_MS)
  }

  // Under Reduce Transparency and Increase Contrast the window is solid whatever is saved, so the miniatures are opaque.
  const solid = a11y.reduceTransparency || a11y.increaseContrast
  const edge = t.contrast ? t.borderHeavy : t.border
  const bar = ink(t, 0.16)
  const flat = { variant, width: previewWidth, height: previewHeight, edge, bar }
  const full = 100
  const optionValues = useMemo(() => {
    const elements = elementsOf(variant, 60)
    return {
      solid: { sidebar: full, content: full, elements: full },
      sidebar: { sidebar: DEFAULT_VARIANT_MATERIAL.sidebarOpacity, content: full, elements: elementsOf(variant, DEFAULT_VARIANT_MATERIAL.surfaceOpacity) },
      full: { sidebar: 85, content: 85, elements },
    } satisfies Record<MaterialOption, { sidebar: number; content: number; elements: number }>
  }, [variant])
  const previews = OPTIONS.map((o) => {
    const v = o.value === option && o.value !== 'solid' ? { sidebar: shown.sidebar, content: shown.content, elements: shown.elements } : optionValues[o.value]
    const alpha = solid ? { sidebar: 100, content: 100, elements: 100 } : v
    return { Preview: WindowMini, props: { ...flat, ...alpha } satisfies WindowMiniProps }
  })

  // An Elements or Blur value the user has not moved and the saved material leaves at its default reads as such.
  const elementsAuto = m.surfaceOpacity === null && live.elements === undefined
  const blurAuto = m.blur === null && live.blur === undefined
  const summary = materialSummary({ sidebarOpacity: shown.sidebar, contentOpacity: shown.content, blur: blurAuto ? null : blurFromPercent(shown.blur) }, elementsAuto ? null : shown.elements, showBlur)
  const keys: readonly SliderKey[] = showBlur ? SLIDER_KEYS : SLIDER_KEYS.filter((key) => key !== 'blur')
  const busy = phase.current !== 'idle'
  const minOf = (key: SliderKey) => (key === 'elements' ? floorOf(variant) : key === 'blur' ? 1 : OPACITY_MIN)
  const innerHeight = keys.length * SLIDER_ROW + 6

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: column }}>
      <CardGroup label="Window material" options={OPTIONS} value={option} card={card} previewHeight={previewHeight} previews={previews} onPick={(v) => pick(v, true)} />
      <div style={{ display: 'flex', width: column, minHeight: 32, marginTop: 10, paddingLeft: 4, paddingRight: 4 }}>
        <Swap active={option} kind="text" style={{ width: column - 8, alignItems: 'flex-start', justifyContent: 'flex-start' }} innerStyle={{ width: column - 8, alignItems: 'flex-start', justifyContent: 'flex-start' }}>
          <Label color={t.textTertiary} size={12} lineHeight={16} style={{ width: '100%' }}>{MATERIAL_CAPTION[option]}</Label>
        </Swap>
      </div>
      <Collapse open={option !== 'solid'}>
        <div style={{ display: 'flex', flexDirection: 'column', width: column }}>
          <div
            testId="prefs-adjust"
            role="button"
            tabIndex={0}
            aria-expanded={open}
            aria-label="Adjust window material"
            onClick={() => setOpen((v) => !v)}
            onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') { e.preventDefault(); setOpen((v) => !v) } }}
            style={{
              display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, width: column, height: 36, marginTop: 6, paddingLeft: 4, paddingRight: 4, borderRadius: 10, cursor: 'pointer',
              hover: { backgroundColor: t.hover }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: -2 },
            }}
          >
            <Chevron open={open} size={12} color={t.iconSecondary} />
            <Label color={t.text} size={13} lineHeight={18} weight={600} style={{ pointerEvents: 'none' }}>Adjust</Label>
            <div style={{ display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0, justifyContent: 'flex-end', pointerEvents: 'none' }}>
              {!open && <Label color={t.textTertiary} size={12} lineHeight={16} truncate style={{ fontVariantNumeric: 'tabular-nums' } as never}>{summary}</Label>}
            </div>
          </div>
          <Collapse open={open} height={innerHeight}>
            <div role="group" aria-label="Window material values" style={{ display: 'flex', flexDirection: 'column', paddingTop: 4, paddingBottom: 2, paddingLeft: 4 }}>
              {keys.map((key) => (
                <SliderRow key={key} name={key} value={shown[key]} min={minOf(key)} active={busy} onChange={onChange} onCommit={onCommit} />
              ))}
            </div>
          </Collapse>
        </div>
      </Collapse>
    </div>
  )
})

