// A composer attachment, expanded (desktop `ResponseImage.tsx` lightbox, opened from `ComposerImageAttachment`): the image
// grows out of its 64px tile onto a dimmed scrim and returns to the tile when closed by pointer (shared-element zoom: 300 ms on
// the desktop's open curve, 200 ms back on its close curve, the image clearing an 8 px blur on the way in like `t-img`). The
// scrim and the toolbar (name, Copy, Download, Close) fade with a small nudge. Escape and a keyboard open are instant; Reduce
// Motion fades only. Every frame is paint-only (`paintTransform`): no React render, layout or island work while it moves.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { PaintTransformProps, PaintTransformValue } from '@gpuix/native/host'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { kitOverlayOpen } from '../kit/AlertDialog.tsx'
import { BLUR, DISTANCE, DURATION, EASE } from '../motion/kit.tsx'
import { nextPresenceGeneration } from '../motion/Presence.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { isWindowVisible } from '../native/visibility.ts'
import { ImageActions } from '../platform/ImageActions.tsx'
import { imageSize } from '../transcript/images.tsx'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { useWebOcclusion } from '../native/web-occlusion.ts'

/** `LIGHTBOX_OPEN_MS` / `LIGHTBOX_CLOSE_MS` and their curves (`components/kybern/ResponseImage.tsx:18-22`). */
const OPEN = { duration: 0.3, ease: [0.32, 0.72, 0, 1] as [number, number, number, number] }
const CLOSE = { duration: 0.2, ease: [0.4, 0, 1, 1] as [number, number, number, number] }
/** The toolbar card above the image and the gap under it. */
const BAR = 48
const GAP = 8
/** `Dialog`'s scrim (black at 60%). */
const SCRIM = 'rgba(0, 0, 0, 0.6)'

type Rect = { x: number; y: number; width: number; height: number }

/** The transform that lays an image painted at `to` over `from` (uniform scale from the width, centres aligned): desktop `zoomTransform`. */
export function zoomFrom(from: Rect, to: Rect): PaintTransformValue {
  return {
    scale: to.width > 0 ? from.width / to.width : 1,
    translateX: from.x + from.width / 2 - (to.x + to.width / 2),
    translateY: from.y + from.height / 2 - (to.y + to.height / 2),
  }
}

/** Where the expanded image sits: as large as fits (at most 1000 px wide, never upscaled), centred under the toolbar. */
export function lightboxRect(window: { width: number; height: number }, size: { width: number; height: number } | null): Rect {
  const maxWidth = Math.max(160, Math.min(1000, window.width - 80))
  const maxHeight = Math.max(120, window.height - 96 - BAR - GAP)
  const ratio = size ? Math.min(maxWidth / size.width, maxHeight / size.height, 1) : 1
  const width = Math.round(size ? size.width * ratio : maxWidth)
  const height = Math.round(size ? size.height * ratio : maxHeight)
  const top = Math.round((window.height - (height + BAR + GAP)) / 2)
  return { x: Math.round((window.width - width) / 2), y: top + BAR + GAP, width, height }
}

/**
 * `from`: the tile's window rect when opened by pointer, or null (keyboard: no zoom). `tile()` reads the tile's rect again at
 * close time, so the image returns to where the tile is now. `onClose` runs once the exit has played.
 */
export function AttachmentLightbox({ source, label, from, tile, onClose }: { source: string; label: string; from: Rect | null; tile: () => Rect | null; onClose: () => void }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const window = renderer.getWindowSize?.() ?? { width: 900, height: 600 }
  const size = useMemo(() => imageSize(source), [source])
  const rect = lightboxRect(window, size)
  const animate = PATCHED_NATIVE && !!from
  const web = useWebOcclusion(undefined, 0, 0.6)
  // `closing`: the exit's target (back into the tile, or a fade when the tile is gone or motion is reduced).
  const [closing, setClosing] = useState<{ generation: number; to: PaintTransformValue | null } | null>(null)
  const done = useRef(false)
  const finish = () => { if (!done.current) { done.current = true; onClose() } }
  const close = (keyboard: boolean) => {
    if (closing) return
    if (keyboard || !PATCHED_NATIVE) return finish()
    const back = !REDUCED_MOTION ? tile() : null
    setClosing({ generation: nextPresenceGeneration(), to: back ? zoomFrom(back, rect) : null })
  }
  // A hidden window has no native frames, so a pending exit would never complete.
  useEffect(() => { if (closing && !isWindowVisible()) finish() })

  const enter: PaintTransformProps | undefined = !animate ? undefined : REDUCED_MOTION
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: [...EASE.smoothOut] } }
    : { initial: { ...zoomFrom(from!, rect), blur: BLUR.large }, animate: { scale: 1, translateX: 0, translateY: 0, blur: 0, opacity: 1 }, transition: OPEN }
  const image: PaintTransformProps | undefined = !closing ? enter : {
    initial: false,
    animate: closing.to ? { ...closing.to, blur: 0, opacity: 1 } : { opacity: 0 },
    transition: closing.to ? CLOSE : { duration: 0.1, ease: [...EASE.out] },
    generation: closing.generation,
  }
  const fade = (nudge: number): PaintTransformProps | undefined => !PATCHED_NATIVE ? undefined : closing
    ? { initial: false, animate: { opacity: 0, translateY: REDUCED_MOTION ? 0 : nudge }, transition: { duration: closing.to ? CLOSE.duration * 0.75 : 0.1, ease: [...EASE.out] } }
    : animate || REDUCED_MOTION
      ? { initial: { opacity: 0, translateY: REDUCED_MOTION ? 0 : nudge }, animate: { opacity: 1, translateY: 0 }, transition: { duration: REDUCED_MOTION ? DURATION.quick : 0.2, ease: [...EASE.smoothOut] } }
      : undefined
  const outline = t.variant === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'
  return (
    // An anchored layer paints an opaque backing unless it asks for none (`backdrop: { blur: 0 }`); the scrim is our own
    // child so it can fade. The web occlusion keeps an embedded browser preview under the scrim.
    <anchored backdrop={{ blur: 0 }} position={{ x: 0, y: 0 }} fit="snap" snapMargin={0} deferred priority={4} occlude>
      <div testId={web.id} style={{ display: 'flex' }}>
      <div testId="attachment-lightbox" tabIndex={0} autoFocus
        onKeyDown={(e: { key?: string }) => { if (e.key === 'escape' && !kitOverlayOpen()) close(true) }}
        style={{ position: 'relative', width: window.width, height: window.height }}
      >
      {/* The scrim takes outside clicks; the image and toolbar sit above it. */}
      <div testId="attachment-lightbox-scrim" onClick={() => close(false)} paintTransform={fade(0)} style={{ position: 'absolute', left: 0, top: 0, width: window.width, height: window.height, backgroundColor: SCRIM }} />
      <div paintTransform={fade(-DISTANCE.micro)} style={{ position: 'absolute', left: rect.x, top: rect.y - BAR - GAP, width: rect.width, height: BAR, display: 'flex', alignItems: 'center', paddingLeft: 16, paddingRight: 116, borderRadius: 14, borderWidth: 1, borderColor: t.borderLight, backgroundColor: t.popover }}>
        <Label color={t.text} size={13} weight={500} truncate>{label}</Label>
        <ImageActions source={source} label={label} />
        <div testId="attachment-lightbox-close" role="button" aria-label="Close preview" onClick={() => close(false)}
          style={{ position: 'absolute', top: 10, right: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonTertiaryHover } }}>
          <Icon source={N.x} size={14} color={t.iconSecondary} />
        </div>
      </div>
      <div
        testId="attachment-lightbox-image"
        paintTransform={image}
        onMotionComplete={e => { if (closing && e.motionGeneration === closing.generation) finish() }}
        style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, display: 'flex', borderRadius: 12, boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 50, spreadRadius: -12, color: 'rgba(0, 0, 0, 0.6)' } }}
      >
        <img src={source} alt={label} objectFit="contain" style={{ width: rect.width, height: rect.height, borderRadius: 12, borderWidth: 1, borderColor: outline }} />
      </div>
      </div>
      </div>
    </anchored>
  )
}
