// The desktop's motion system (`styles/motion.css`, `lib/kit/disclosureMotion.ts`) on GPUIX's native paths.
//
// Entrances, popups, reveals and swaps are `paintTransform`: the host paints a retained subtree scaled, moved, faded and
// blurred on native display callbacks, with no React render, layout, prepaint or island wake per frame
// (`native/README.md` "Paint-only subtree transforms"), so they carry the desktop's scale and blur too. Only `Collapse`
// (a height change) still has to be a layout tween (`motion.div` interpolates in Rust, but every frame re-lays out the window).
//
// Reduce Motion drops movement, scale and blur and keeps a 150 ms opacity fade, like the desktop. With the stock addon
// (`KYBERN_GPUIX_NATIVE=npm`, a diagnostic mode) every `paintTransform` builder returns `undefined` and the UI just appears.
import { motion, useGpuixRequired, type PublicInstance, type StyleDesc } from '@gpuix/react'
import type { PaintTransformProps, PaintTransformValue } from '@gpuix/native/host'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import { BLUR, DISCLOSURE, DISTANCE, DURATION, EASE, HOVER_FADE, SCALE, SPRING, type Ease } from './tokens.ts'

// The desktop's tokens (`motion.css:13-74`) live in `tokens.ts` (a leaf, because `ui.tsx` -> `press.ts` -> this module ->
// `ui.tsx` is an import cycle); they are re-exported here, so callers keep importing them from `motion/kit.tsx`.
export { BLUR, DISCLOSURE, DISTANCE, DURATION, EASE, HOVER_FADE, SCALE, SPRING, type Ease }

const tween = (duration: number, ease: Ease, delay = 0) => ({ duration, ease: [...ease] as [number, number, number, number], delay })
const bezier = (ease: Ease) => [...ease] as [number, number, number, number]

/**
 * Spread on a window's root: every `hover` / `active` background or border colour below it eases over `HOVER_FADE`
 * (native `hoverTransition`, painted in place after the flip). A press lands at once; a rest colour changed by state (a
 * selection moved by the keyboard) stays instant. `KYBERN_HOVER_FADE=0` (the measurement control) and the stock addon snap.
 * Colour is not motion, so Reduce Motion keeps it, like the desktop's `transition-colors`.
 */
export const HOVER_FADE_ROOT: { hoverTransition?: typeof HOVER_FADE } = PATCHED_NATIVE && process.env.KYBERN_HOVER_FADE !== '0' ? { hoverTransition: HOVER_FADE } : {}

/** What a `paintTransform` rests at: every field at its neutral value (a retarget back from any exit lands here). */
export const IDENTITY: Required<PaintTransformValue> = { opacity: 1, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, translateX: 0, translateY: 0, blur: 0 }

/** The neutral value for exactly the fields `from` sets, so a tween never touches a field it was not asked to. */
function restOf(from: PaintTransformValue): PaintTransformValue {
  const to: PaintTransformValue = {}
  for (const key of Object.keys(from) as (keyof PaintTransformValue)[]) to[key] = IDENTITY[key]
  return to
}

/** Reduce Motion for entrances and fades: opacity only, `--duration-quick`, no movement, scale or blur. */
const REDUCED_FADE: PaintTransformProps = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: bezier(EASE.smoothOut) } }

// ─── Entrances ────────────────────────────────────────────────────────────

/**
 * The desktop's enter-only keyframes, by name: every one starts at `opacity: 0`, `distance` px low (`translateY`) and
 * `scale`/`blur` when the desktop's class has them, and settles at identity. `delayStep` is the stagger per index.
 */
export const ENTER = {
  /** `t-row-enter`: work rows appearing in a live turn. */
  row: { distance: DISTANCE.micro, duration: DURATION.fast, blur: BLUR.small },
  /** `t-panel-enter`: cards stacked above the composer. */
  panel: { distance: DISTANCE.base, duration: DURATION.medium, scale: 0.985, blur: BLUR.small },
  /** `t-section-enter` / `settings-section-in`: keyed remounts (settings sections, pages). */
  section: { distance: DISTANCE.small, duration: DURATION.fast, blur: BLUR.small },
  /** `t-stagger`: the home heading lines, 70 ms apart (blur is dropped from the fifth line: at most four blur passes at once). */
  stagger: { distance: DISTANCE.medium, duration: DURATION.verySlow, blur: BLUR.medium, delayStep: 0.07 },
  /** `chat-message-send-enter` (kit.css:337): the bubble the user just sent, 260 ms, growing from its right edge. */
  send: { distance: DISTANCE.small, duration: 0.26, scale: 0.985, blur: BLUR.small, origin: [1, 1] as [number, number] },
  /** `t-pane`: the content of a tab or pane that was just switched to. */
  pane: { distance: DISTANCE.micro, duration: DURATION.fast, scale: 0.995 },
  /** `sidebar-surface-enter`: the sidebar list after its surface changed (`--ease-out`, 160 ms). */
  surface: { distance: DISTANCE.micro, duration: 0.16, ease: EASE.out },
  /** `t-img`: an image that finished loading, resolving from a 8 px blur. */
  image: { distance: 0, duration: DURATION.slow, scale: 0.985, blur: BLUR.large },
} as const satisfies Record<string, { distance: number; duration: number; scale?: number; blur?: number; ease?: Ease; delayStep?: number; origin?: [number, number] }>

type EnterKind = keyof typeof ENTER

/**
 * The paint-only entrance of an `ENTER` kind (`paintTransform`): opacity 0 → 1, `distance` px low → rest, plus the kind's
 * scale and blur. `index` staggers (`stagger` only: `index × 70 ms`, no blur from index 4). Reduce Motion fades 150 ms with
 * no movement; `undefined` with the stock addon (the content simply appears). Spread it on any host `div`:
 * `<div paintTransform={play ? enterTransform('pane') : undefined}>`.
 */
export function enterTransform(kind: EnterKind, index = 0): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  if (REDUCED_MOTION) return REDUCED_FADE
  const spec: { distance: number; duration: number; scale?: number; blur?: number; ease?: Ease; delayStep?: number; origin?: [number, number] } = ENTER[kind]
  const initial: PaintTransformValue = { opacity: 0 }
  if (spec.distance) initial.translateY = spec.distance
  if (spec.scale !== undefined) initial.scale = spec.scale
  const blur = kind === 'stagger' && index >= 4 ? 0 : spec.blur
  if (blur) initial.blur = blur
  return {
    initial,
    animate: restOf(initial),
    transition: tween(spec.duration, spec.ease ?? EASE.smoothOut, spec.delayStep ? index * spec.delayStep : 0),
    ...(spec.origin ? { origin: spec.origin } : {}),
  }
}

/**
 * Fade up into place once, on mount (`paintTransform`: no layout, render or island work per frame; the layout slot is final
 * from the first frame). `play={false}` renders plainly (rows that were already there, history pages, keyboard
 * navigation): the desktop only animates fresh content. A remount restarts it.
 */
export function Rise({
  children,
  kind = 'row',
  index = 0,
  play = true,
  style,
  testId,
}: {
  children: ReactNode
  kind?: EnterKind
  /** Position in a staggered group (`t-stagger` uses index × 70 ms). */
  index?: number
  play?: boolean
  style?: StyleDesc
  testId?: string
}) {
  if (!play) return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', ...style }}>{children}</div>
  return (
    <div paintTransform={enterTransform(kind, index)} style={{ display: 'flex', flexDirection: 'column', position: 'relative', ...style }}>
      {testId ? <div testId={testId} style={{ display: 'flex', flexDirection: 'column' }}>{children}</div> : children}
    </div>
  )
}

// ─── Popups ───────────────────────────────────────────────────────────────

/** Menu (`menu.tsx`) and tooltip (`tooltip.tsx`) open timings. */
export const POPUP = {
  menu: { duration: DURATION.fast, ease: EASE.smoothOut, distance: DISTANCE.micro },
  tooltip: { duration: DURATION.quick, ease: EASE.out, distance: DISTANCE.micro / 2 },
} as const

type Side = 'top' | 'bottom' | 'left' | 'right'
type Align = 'start' | 'center' | 'end'

/**
 * `--transform-origin` of a popup: the fractions of its box nearest the trigger. `side` is where the popup sits relative to the
 * trigger, `align` how it lines up along that edge (`bottom` + `start` grows from its top-left corner, `top` + `end` from its
 * bottom-right, `right` + `center` from the middle of its left edge).
 */
export function popupOrigin(side: Side = 'bottom', align: Align = 'start'): [number, number] {
  const along = align === 'start' ? 0 : align === 'end' ? 1 : 0.5
  switch (side) {
    case 'bottom': return [along, 0]
    case 'top': return [along, 1]
    case 'right': return [0, along]
    case 'left': return [1, along]
  }
}

/**
 * The paint-only open of a popup (`menu.tsx:104`, `popover.tsx:64`): scale `--scale-medium` (0.97) and a 2 px blur → rest and
 * opacity 0 → 1, 250 ms `--ease-smooth-out`, about `origin`. `kind: 'tooltip'` (`tooltip.tsx`): scale 0.98 and opacity only,
 * 150 ms `--ease-out`. Reduce Motion fades 150 ms; `undefined` with the stock addon.
 */
export function popupTransform(origin: [number, number] = [0.5, 0.5], kind: keyof typeof POPUP = 'menu'): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  if (REDUCED_MOTION) return { ...REDUCED_FADE, origin }
  const initial: PaintTransformValue = kind === 'tooltip' ? { opacity: 0, scale: SCALE.small } : { opacity: 0, scale: SCALE.medium, blur: BLUR.small }
  return { initial, animate: restOf(initial), transition: tween(POPUP[kind].duration, POPUP[kind].ease), origin }
}

/**
 * Wrap a popup's content (inside its `<anchored>` / Select / Combobox surface). It scales up from the trigger side like the
 * desktop's Base UI popup (`popupTransform`), painted natively with no layout per frame. `side` is where the popup sits
 * relative to its trigger. Closing is instant (unmount) here; `PopupLayer` has the exit.
 */
export function Popup({ children, side = 'bottom', align = 'start', kind = 'menu', style }: { children: ReactNode; side?: Side; align?: Align; kind?: keyof typeof POPUP; style?: StyleDesc }) {
  return (
    <div paintTransform={popupTransform(popupOrigin(side, align), kind)} style={{ display: 'flex', flexDirection: 'column', ...style }}>
      {children}
    </div>
  )
}

// ─── Hover reveals ────────────────────────────────────────────────────────

/**
 * `t-reveal`: a control shown while its row is hovered or focused. In: opacity 0 → 1 and a 4 px slide in from the right over
 * 150 ms `--ease-out`; out: opacity back to 0 over 100 ms (exits ~30% faster). Set `slide = false` for opacity only. Spread it on
 * the control's wrapper (`paintTransform={revealTransform(hovered)}`); keep the wrapper mounted for ~100 ms after `shown` goes
 * false (see `Presence` + `EXIT.reveal`) and give it `pointerEvents: 'none'` while it is not shown. First render is at rest.
 * Reduce Motion: opacity only.
 */
export function revealTransform(shown: boolean, slide = true): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  return {
    initial: false,
    animate: { opacity: shown ? 1 : 0, translateX: shown || !slide || REDUCED_MOTION ? 0 : DISTANCE.micro },
    transition: { duration: shown ? DURATION.quick : 0.1, ease: bezier(EASE.out) },
    // Shown is the rest (identity): stay retained, so hiding is paint-only from its first frame.
    retain: true,
  }
}

// ─── Disclosure ───────────────────────────────────────────────────────────

/**
 * `disclosureShellClassName`: content opens and closes with a 220 ms height
 * and opacity tween (ease-out). GPUIX tweens need a numeric height, so the
 * content is measured after its first paint, animated to that height, then
 * left at its natural height. Closing measures, animates to 0, then unmounts
 * the children (desktop: "unmount closed details after their exit").
 *
 * Pass `height` when the content height is known (e.g. N sidebar rows × 30):
 * no measuring frame is needed.
 */
let disclosureGeneration = 2_000_000
export function Collapse({ open, children, height: known, testId, closeDuration }: { open: boolean; children: ReactNode; height?: number; testId?: string; /** Closing is faster than opening when set (toasts leave in 160 ms). */ closeDuration?: number }) {
  const renderer = useGpuixRequired()
  const inner = useRef<PublicInstance>(null)
  // 'open': natural height. 'opening'/'closing': tweening. 'closed': unmounted.
  const [phase, setPhase] = useState<'open' | 'opening' | 'closing' | 'closed'>(open ? 'open' : 'closed')
  const [from, setFrom] = useState(0)
  const [to, setTo] = useState<number | null>(null)
  const [generation, setGeneration] = useState(0)
  const lastOpen = useRef<number | null>(known ?? null)

  const measure = () => {
    const id = inner.current?.id
    const bounds = id != null ? renderer.getElementBounds?.(id) : null
    return bounds ? bounds.height : null
  }

  useLayoutEffect(() => {
    if (REDUCED_MOTION) {
      setPhase(open ? 'open' : 'closed')
      return
    }
    if (open && (phase === 'closed' || phase === 'closing')) {
      // From 'closed' the element mounts fresh; from 'closing' it is reused and
      // tweens back from its current height.
      setFrom(phase === 'closing' ? (measure() ?? 0) : 0)
      setTo(known ?? (phase === 'closing' ? lastOpen.current : null))
      setPhase('opening')
    } else if (!open && (phase === 'open' || phase === 'opening')) {
      const h = phase === 'open' ? (measure() ?? known ?? 0) : (measure() ?? to ?? 0)
      lastOpen.current = h || lastOpen.current
      setFrom(h)
      setTo(0)
      setPhase('closing')
      if (phase === 'open') setGeneration((g) => g + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Opening with an unknown height: measure the inner content after it paints.
  useEffect(() => {
    if (phase !== 'opening' || to !== null) return
    let tries = 0
    const tick = () => {
      const h = measure()
      if (h != null && h > 0) {
        lastOpen.current = h
        setTo(h)
      }
      else if (++tries < 10) timer = setTimeout(tick, 16)
      else setPhase('open')
    }
    let timer = setTimeout(tick, 16)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, to, generation])

  const nativeGeneration = useMemo(() => ++disclosureGeneration, [phase, from, to, generation])
  if (REDUCED_MOTION) return open ? <div testId={testId} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>{children}</div> : null
  if (phase === 'closed') return null
  // One element carries the content from the start of an opening through its
  // whole open life, so settling never remounts the children (their state
  // survives). Only a close that starts from the settled state takes a fresh
  // element, which needs a numeric starting height; the content is leaving.
  const settled = phase === 'open'
  return (
    <div
      // Remove the motion descriptor when settled: the native host otherwise
      // retains the last animated numeric height when children grow later.
      // Keep this host and its children mounted across the whole disclosure.
      {...((settled ? {} : { motion: {
        generation: nativeGeneration,
        isExit: false,
        initial: { height: from, opacity: phase === 'opening' ? 0 : 1 },
        animate: { height: to ?? from, opacity: phase === 'opening' ? (to === null ? 0 : 1) : 0 },
        transition: tween(phase === 'closing' && closeDuration ? closeDuration : DISCLOSURE, EASE.out),
      } }) as object)}
      onMotionComplete={event => {
        if (event.motionGeneration !== nativeGeneration) return
        if (phase === 'opening' && to !== null) setPhase('open')
        if (phase === 'closing') setPhase('closed')
      }}
      style={{ display: 'flex', flexDirection: 'column', overflow: settled ? undefined : 'hidden', flexShrink: 0 }}
    >
      <div ref={inner} testId={testId} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        {children}
      </div>
    </div>
  )
}

// ─── Swaps ────────────────────────────────────────────────────────────────

let swapGeneration = 3_000_000

/** `t-text-swap` (`motion.css:206`) and `t-icon-swap` (`:250`): [incoming, outgoing] start/end values and timings. */
function swapTransforms(kind: 'text' | 'icon', generation: number): { enter: PaintTransformProps; leave: PaintTransformProps } | undefined {
  if (!PATCHED_NATIVE || REDUCED_MOTION) return undefined
  if (kind === 'icon') {
    const hidden: PaintTransformValue = { opacity: 0, scale: 0.6, blur: BLUR.small }
    const transition = tween(DURATION.fast, EASE.inOut)
    return {
      enter: { initial: hidden, animate: restOf(hidden), transition },
      leave: { initial: restOf(hidden), animate: hidden, transition, generation },
    }
  }
  const entering: PaintTransformValue = { opacity: 0, translateY: DISTANCE.micro, blur: BLUR.small }
  const leaving: PaintTransformValue = { opacity: 0, translateY: -DISTANCE.micro, blur: BLUR.small }
  return {
    enter: { initial: entering, animate: restOf(entering), transition: tween(DURATION.fast, EASE.smoothOut) },
    leave: { initial: restOf(leaving), animate: leaving, transition: tween(DURATION.quick, EASE.inOut), generation },
  }
}

/**
 * `TextSwap` / `IconSwap` (`components/kybern/motion.tsx`): when `active` changes, the new state rises in while the old one
 * leaves, overlapping, both painted natively (`paintTransform`: no layout or render per frame).
 *
 *  - `kind="text"` (default): in 250 ms `--ease-smooth-out` from 4 px below with a 2 px blur; out 150 ms `--ease-in-out` to 4 px
 *    above with a 2 px blur. The outgoing copy sits at the wrapper's top-left.
 *  - `kind="icon"`: both 250 ms `--ease-in-out`, scale 0.6 and a 2 px blur on the way out and in; the outgoing copy is
 *    centred over the incoming one.
 *
 * The incoming child stays in flow (it sizes the wrapper); the outgoing child is an absolutely positioned, non-interactive
 * copy of what was rendered last, unmounted when its exit completes. A change during an exit drops the older copy at once
 * (never more than two). `still` skips the entrance of the first state only (the desktop's "the first paint renders without
 * motion"); callers that keep one `Swap` mounted for the life of a control pass it. Reduce Motion: a 150 ms opacity fade of
 * the incoming state, no copy kept. Stock addon: the new state just replaces the old.
 */
export function Swap({ active, children, style, kind = 'text', still = false, innerStyle, leavingStyle }: {
  active: string
  children: ReactNode
  style?: StyleDesc
  kind?: 'text' | 'icon'
  still?: boolean
  /** Extra style for the incoming and the outgoing child's box (a truncating title needs `minWidth: 0` / `flexGrow: 1` on both). */
  innerStyle?: StyleDesc
  /** Extra style for the outgoing copy only (`right: 0` keeps a truncating title inside the wrapper while it leaves). */
  leavingStyle?: StyleDesc
}) {
  const first = useRef(active)
  const changed = useRef(false)
  if (active !== first.current) changed.current = true
  const last = useRef<{ key: string; node: ReactNode }>({ key: active, node: children })
  const [leaving, setLeaving] = useState<{ id: number; node: ReactNode } | null>(null)
  const transforms = swapTransforms(kind, 0)
  if (last.current.key !== active) {
    if (transforms && PATCHED_NATIVE && !REDUCED_MOTION) setLeaving({ id: ++swapGeneration, node: last.current.node })
    last.current = { key: active, node: children }
  } else last.current.node = children
  const out = leaving ? swapTransforms(kind, leaving.id) : undefined
  const fade = REDUCED_MOTION && PATCHED_NATIVE && !(still && !changed.current) ? REDUCED_FADE : undefined
  const enter = still && !changed.current ? undefined : transforms?.enter ?? fade
  const base = { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', ...style } as const
  return (
    <div style={base}>
      {/* The outgoing copy paints last: a blur pass blurs what is painted under it, so the incoming state must not sit above the old one at the start. */}
      <div key={active} paintTransform={enter} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', ...innerStyle }}>
        {children}
      </div>
      {leaving && out && (
        <div
          key={`out-${leaving.id}`}
          paintTransform={out.leave}
          onMotionComplete={event => { if (event.motionGeneration === leaving.id) setLeaving(current => (current?.id === leaving.id ? null : current)) }}
          style={kind === 'icon'
            ? { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', ...innerStyle, ...leavingStyle }
            : { position: 'absolute', left: 0, top: 0, display: 'flex', alignItems: 'center', pointerEvents: 'none', ...innerStyle, ...leavingStyle }}
        >
          {leaving.node}
        </div>
      )}
    </div>
  )
}

/**
 * `Swap` for a state that flips after mount (copy → check, spinner → brain): the first state paints plainly and every later
 * change cross-swaps, including the very first one (the previous state is kept for its exit). Use this, not a plain div
 * until the first change and a `Swap` after it: that would lose the outgoing state of the first change.
 */
export function SwapOnChange({ active, children, style, kind = 'text', innerStyle, leavingStyle }: { active: string; children: ReactNode; style?: StyleDesc; kind?: 'text' | 'icon'; innerStyle?: StyleDesc; leavingStyle?: StyleDesc }) {
  return <Swap active={active} style={style} kind={kind} innerStyle={innerStyle} leavingStyle={leavingStyle} still>{children}</Swap>
}

// ─── Embedded documents ───────────────────────────────────────────────────

/**
 * A native web document (preview, visual reply) arriving with the desktop's 150 ms fade (`kit.css` 3643, `.visual-reply`
 * frame): its WKWebView layer fades in Core Animation, so the app presents no frames (`webHost.present`, N3). Call it right
 * before the document is first shown. Opacity only, so Reduce Motion keeps it; the stock addon has no embedded documents.
 */
export function webDocumentEnter(id: string, present: (id: string, to: { opacity: number }, motion: { from: { opacity: number }; duration: number; ease: readonly number[] }) => void) {
  present(id, { opacity: 1 }, { from: { opacity: 0 }, duration: DURATION.quick, ease: EASE.out })
}
