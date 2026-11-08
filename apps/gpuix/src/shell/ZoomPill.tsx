// The interface size readout (#292): a small pill at the top centre, 8 px under the title bar, each time a shortcut or
// the View menu zooms (`shell/uiZoom.ts` `onZoomAnnounce`). It holds 1 s after the last press; a repeat press swaps the
// number in place and restarts the hold without replaying the entrance. In: 180 ms opacity, scale 0.96 → 1, y −4 → 0
// and a 2 px blur clearing; out: 150 ms ease-in to scale 0.96 and blur 2. Reduce Motion: 120 ms opacity only. The
// motion is `paintTransform` (no React render per frame), and the pill takes no pointer input.
import { useWindowSize } from '@gpuix/react'
import type { PaintTransformProps } from '@gpuix/native/host'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { frostFill, useGlass } from '../platform/glass.ts'
import { TITLEBAR } from '../nav/TitleBar.tsx'
import { formatZoom, onZoomAnnounce, type ZoomAnnouncement } from './uiZoom.ts'

const HOLD_MS = 1000
const ENTER = 0.18, EXIT = 0.15, FADE = 0.12
const EASE_ENTER: [number, number, number, number] = [0.2, 0, 0, 1]
const EASE_EXIT: [number, number, number, number] = [0.4, 0, 1, 1]
/** An explicit `{ blur: 0 }`: no opaque backing under the layer, so the pill fades as one (`toasts.tsx` `BACKING`). */
const BACKING = { blur: 0 }

type Shown = ZoomAnnouncement & { leaving: boolean; generation: number }

function transform(leaving: boolean): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  if (REDUCED_MOTION) return { initial: { opacity: 0 }, animate: { opacity: leaving ? 0 : 1 }, transition: { duration: FADE, ease: EASE_ENTER } }
  return leaving
    ? { initial: false, animate: { opacity: 0, scale: 0.96, blur: 2, translateY: 0 }, transition: { duration: EXIT, ease: EASE_EXIT } }
    : { initial: { opacity: 0, scale: 0.96, blur: 2, translateY: -4 }, animate: { opacity: 1, scale: 1, blur: 0, translateY: 0 }, transition: { duration: ENTER, ease: EASE_ENTER } }
}

export function ZoomPill() {
  const [shown, setShown] = useState<Shown | null>(null)
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const gone = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    let generation = 0
    const off = onZoomAnnounce((next) => {
      clearTimeout(hold.current)
      clearTimeout(gone.current)
      // A press while it shows (or leaves) keeps the same pill: only the text changes.
      setShown((current) => ({ ...next, leaving: false, generation: current && !current.leaving ? current.generation : ++generation }))
      hold.current = setTimeout(() => {
        setShown((current) => (current ? { ...current, leaving: true } : current))
        gone.current = setTimeout(() => setShown(null), (REDUCED_MOTION ? FADE : EXIT) * 1000 + 30)
      }, HOLD_MS)
    })
    return () => { off(); clearTimeout(hold.current); clearTimeout(gone.current) }
  }, [])
  if (!shown) return null
  return <Pill key={shown.generation} shown={shown} />
}

function Pill({ shown }: { shown: Shown }) {
  const t = useTheme()
  const g = useGlass()
  const { width } = useWindowSize()
  // Stable per phase: a new number in the same pill must not replay the entrance.
  const motion = useMemo(() => transform(shown.leaving), [shown.leaving])
  const shadow = { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: -6, color: t.variant === 'dark' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.18)' }
  return (
    <anchored position={{ x: width / 2, y: TITLEBAR + 8 }} anchor="topCenter" fit="snap" snapMargin={8} deferred priority={7} backdrop={BACKING} style={{ borderRadius: 14 }}>
      <div testId="ui-zoom-pill" aria-live="polite" paintTransform={motion}
        style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 12, paddingRight: 12, borderRadius: 14, borderWidth: 1, borderColor: t.cardEdge, backgroundColor: frostFill(g, 'pills', t.glass.dense), boxShadow: shadow, pointerEvents: 'none' }}>
        <Label color={t.text} size={13} lineHeight={18} weight={500} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' } as never}>{formatZoom(shown.zoom)}</Label>
        {shown.limit && <Label color={t.textSecondary} size={13} lineHeight={18} weight={400} style={{ pointerEvents: 'none' }}>{' · Largest that fits'}</Label>}
      </div>
    </anchored>
  )
}
