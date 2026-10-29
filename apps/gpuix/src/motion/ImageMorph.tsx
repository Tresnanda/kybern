// The image preview, shared by every image a reader can open: an agent reply's image (`transcript/images.tsx`
// `ResponseImage`), the thumbnails in the user's own messages (inline images and asset attachments) and the composer's
// attachment tiles (`Composer.tsx` `Attachments`). Desktop `ResponseImage.tsx`'s lightbox, made a true shared-element morph:
//
// - Open (pointer): the image itself travels from the thumbnail's rect, crop and corner radius to the preview's, one
//   continuous position / size / radius change on the iOS zoom curve (`ZOOM`, 260 ms; 200 ms back). The thumbnail hides
//   while its image is away. The scrim fades in under it; the toolbar (name, Copy, Download, Close) fades in as it lands.
// - Close (pointer): the reverse, into the thumbnail's rect as it is now. A thumbnail that has left the screen gets a shrink
//   and fade towards where it was. A close during the open retargets from the value on screen.
// - Keyboard (Enter/Space open, Escape close): instant. Reduce Motion: a 150 ms cross-fade, no movement, the thumbnail stays.
//
// Zoom (`ZoomSurface.tsx`): once it has landed the image zooms and pans inside `lightboxArea`, the room the window leaves under the
// toolbar. An image that fits in that room opens exactly where it always did; one much taller or wider than the room opens fitted
// to its width (or height) and scrolls along its long axis, so it is no longer shown tiny. A close from a zoomed view fades
// instead of morphing, because the thumbnail only matches the fitted picture.
//
// Paint-only: the image is one retained subtree under a `paintTransform` (translate + scale) whose inner scope clips it to
// the moving crop with a screen-space radius (`clipTop/Right/Bottom/Left` + `clipRadius`, the addon's `paintClip`). No React
// render, layout or island work runs while it moves. An addon without `paintClip` zooms the uncropped image instead.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import type { PaintTransformProps, PaintTransformValue } from '@gpuix/native/host'
import { glyph, Icon } from '../icons.tsx'
import { SquareArrowExpand01Icon } from '@hugeicons/core-free-icons'
import { N } from '../nav/glyphs.ts'
import { kitOverlayOpen } from '../kit/AlertDialog.tsx'
import { DISTANCE, DURATION, EASE, ZOOM } from './kit.tsx'
import { nextPresenceGeneration } from './Presence.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { isWindowVisible } from '../native/visibility.ts'
import { ImageActions } from '../platform/ImageActions.tsx'
import { imageSize } from '../transcript/images.tsx'
import { useTranscriptRowLease } from '../transcript/Window.tsx'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { useWebOcclusion } from '../native/web-occlusion.ts'
import { useNativeWindowSize } from '../native/layout-hooks.ts'
import { limits } from './zoom.ts'
import { useZoomController, useZoomSnapshot, ZoomHud, ZoomSurface } from './ZoomSurface.tsx'
import type { ZoomController } from './zoomController.ts'

export type Rect = { x: number; y: number; width: number; height: number }
/** Where an image sits before it opens: its box on screen, its corner radius, and how it fills that box. */
export type MorphSource = { rect: Rect; radius: number; fit: 'cover' | 'contain' }
/** `paintTransform` values plus the addon's `paintClip` (the clip insets are px of the host box, the radius is on screen). */
export type MorphValue = PaintTransformValue & { clipTop?: number; clipRight?: number; clipBottom?: number; clipLeft?: number; clipRadius?: number }

const bezier = (e: readonly number[]) => [...e] as [number, number, number, number]
type Timing = { duration: number; ease: [number, number, number, number] }
/** Open and close: one curve; the way back is a little quicker, as exits are. */
export const MORPH_OPEN: Timing = { duration: ZOOM.open, ease: bezier(ZOOM.ease) }
export const MORPH_CLOSE: Timing = { duration: ZOOM.close, ease: bezier(ZOOM.ease) }
/** The toolbar card above the image and the gap under it. */
const BAR = 48
const GAP = 8
/** The preview's corner radius. */
export const PREVIEW_RADIUS = 12
/** `Dialog`'s scrim (black at 60%). */
const SCRIM = 'rgba(0, 0, 0, 0.6)'

let clipSupport: boolean | undefined
/** Whether the addon clips a `paintTransform` scope (`paintClip`); read once. */
export function canClip(renderer: unknown): boolean {
  if (clipSupport === undefined) clipSupport = !!(renderer as { getMotionCapabilities?: () => { paintClip?: boolean } }).getMotionCapabilities?.()?.paintClip
  return clipSupport
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

/** The room the expanded image has to zoom in: as wide as fits (at most 1000 px), and as tall as the window leaves under the toolbar. */
export function lightboxArea(window: { width: number; height: number }): Rect {
  const width = Math.max(160, Math.min(1000, window.width - 80))
  const height = Math.max(120, window.height - 96 - BAR - GAP)
  return { x: Math.round((window.width - width) / 2), y: 48 + BAR + GAP, width, height }
}

/**
 * Where the preview image sits when it opens: `rect` is the fitted picture (the morph's target and the toolbar's width), `area` the
 * room it zooms in. An image much taller or wider than the room fits its width (or height) and fills the room: `rect` is `area`.
 */
export function lightboxLayout(window: { width: number; height: number }, size: { width: number; height: number } | null) {
  const area = lightboxArea(window)
  const contain = !size || limits(size, area).axis === 'contain'
  return { area, rect: contain ? lightboxRect(window, size) : area, long: !contain }
}

/**
 * The values that lay the preview image (painted at `to`, radius `PREVIEW_RADIUS`) over its thumbnail: centres aligned,
 * scaled to the size the thumbnail shows it at (`cover` crops it, `contain` shows all of it), and, with `clip`, cut to the
 * thumbnail's box with its radius. `outer` moves and scales the image; `inner` clips it.
 */
export function morphFrom(source: MorphSource, to: Rect, clip: boolean, box: Rect = to): { outer: MorphValue; inner: MorphValue } {
  const { rect } = source
  const fill = source.fit === 'cover' ? Math.max : Math.min
  const scale = to.width > 0 && to.height > 0 ? fill(rect.width / to.width, rect.height / to.height) : 1
  const outer = { scale, translateX: rect.x + rect.width / 2 - (to.x + to.width / 2), translateY: rect.y + rect.height / 2 - (to.y + to.height / 2), shadowOpacity: 0 }
  if (!clip) return { outer: { ...outer, scale: to.width > 0 ? rect.width / to.width : 1 }, inner: {} }
  // The thumbnail's box in the preview image's own (unscaled) pixels, counted from the edges of `box` (the clipped element).
  const x = Math.max(0, (to.width - rect.width / scale) / 2), y = Math.max(0, (to.height - rect.height / scale) / 2)
  const left = to.x - box.x, top = to.y - box.y, right = box.x + box.width - (to.x + to.width), bottom = box.y + box.height - (to.y + to.height)
  return { outer, inner: { clipTop: top + y, clipBottom: bottom + y, clipLeft: left + x, clipRight: right + x, clipRadius: source.radius } }
}
/** At rest in the preview. */
export const LANDED: { outer: MorphValue; inner: MorphValue } = {
  outer: { scale: 1, translateX: 0, translateY: 0, opacity: 1, shadowOpacity: 1 },
  inner: { clipTop: 0, clipBottom: 0, clipLeft: 0, clipRight: 0, clipRadius: PREVIEW_RADIUS },
}

/** A source still on screen (at least half of it inside the window). */
export function onScreen(rect: Rect | null | undefined, window: { width: number; height: number }): rect is Rect {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false
  const w = Math.min(rect.x + rect.width, window.width) - Math.max(rect.x, 0)
  const h = Math.min(rect.y + rect.height, window.height) - Math.max(rect.y, 0)
  return w > 0 && h > 0 && w * h >= (rect.width * rect.height) / 2
}

/**
 * The way back when the thumbnail has gone (scrolled away, unmounted): shrink to its size and fade out towards where it was,
 * kept inside the window.
 */
export function fallbackTo(last: MorphSource, window: { width: number; height: number }, to: Rect, clip: boolean, box: Rect = to) {
  const { rect } = last
  const x = Math.min(Math.max(rect.x, 0), Math.max(0, window.width - rect.width))
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, window.height - rect.height))
  const back = morphFrom({ ...last, rect: { ...rect, x, y } }, to, clip, box)
  return { outer: { ...back.outer, opacity: 0 }, inner: back.inner }
}

/**
 * The opener's side: a ref for the thumbnail's box, `source()` to read where it is now, and `hidden` while its image is away
 * in the preview (so it never shows twice).
 */
export function useMorphSource({ radius, fit }: { radius: number; fit: MorphSource['fit'] }) {
  const renderer = useGpuixRequired()
  const node = useRef<PublicInstance | null>(null)
  const source = (): MorphSource | null => {
    const box = node.current ? renderer.getElementBounds?.(node.current.id) : null
    return box && box.width > 0 && box.height > 0 ? { rect: { x: box.x, y: box.y, width: box.width, height: box.height }, radius, fit } : null
  }
  return { node, source }
}

export interface ImageViewerProps {
  src: string
  label: string
  /** Where the image comes from when opened by pointer; null for a keyboard open (instant) or no thumbnail (a fade). */
  from: MorphSource | null
  /** Where the thumbnail is now, read when the preview closes; null when it has gone. */
  source: () => MorphSource | null
  /** Runs once the close has played (the opener shows its thumbnail again and unmounts the preview). */
  onClose: () => void
  /** Focus to restore after it closes (e.g. the opener, keeping a transcript's reading position). */
  finalFocus?: () => void
  /** "Open in tab" (ADE-54): the image becomes a tab of the thread; the quick look closes. */
  onOpenInTab?: () => void
  testId?: string
}

/** The open preview: scrim, toolbar and the morphing image, on its own top layer. */
const OPEN_TAB = glyph(SquareArrowExpand01Icon)

export function ImageViewer({ src, label, from, source, onClose, finalFocus, onOpenInTab, testId = 'image-viewer' }: ImageViewerProps) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  // An open preview owned by a transcript row keeps that row mounted while its thumbnail scrolls away.
  useTranscriptRowLease(true)
  // Follows window resizes.
  const window = useNativeWindowSize()
  const size = useMemo(() => imageSize(src), [src])
  // `rect`: the fitted picture, which the open and close morph to and from. `area`: the room it zooms in (the toolbar sits over `rect`).
  const { area, rect, long } = lightboxLayout(window, size)
  const home = { x: rect.x + rect.width / 2 - area.x, y: rect.y + rect.height / 2 - area.y }
  const zoom = useZoomController({ image: size, viewport: { width: area.width, height: area.height }, origin: { x: area.x, y: area.y }, scaleFactor: window.scaleFactor, home, reduced: REDUCED_MOTION })
  const clip = canClip(renderer)
  // A tall or wide image is shown as the top (or left) of itself, which no thumbnail matches: it fades in instead of morphing.
  const morph = PATCHED_NATIVE && !!from && !REDUCED_MOTION && !long
  const fadeIn = PATCHED_NATIVE && !!from && (REDUCED_MOTION || long)
  const web = useWebOcclusion(undefined, 0, 0.6)
  const root = useRef<PublicInstance | null>(null)
  const focus = useRef(finalFocus)
  focus.current = finalFocus
  useLayoutEffect(() => () => { queueMicrotask(() => { try { focus.current?.() } catch { /* Window closed. */ } }) }, [])
  // The opening values, decided once: a resize must not restart the entrance.
  const [start] = useState(() => (morph ? morphFrom(from!, rect, clip, area) : null))
  // `closing`: the exit's target (into the thumbnail, towards where it was, or a fade).
  const [closing, setClosing] = useState<{ generation: number; to: { outer: MorphValue; inner: MorphValue }; timing: Timing } | null>(null)
  const done = useRef(false)
  const finish = () => { if (!done.current) { done.current = true; onClose() } }
  const close = (keyboard: boolean) => {
    if (closing) return
    if (keyboard || !PATCHED_NATIVE) return finish()
    const generation = nextPresenceGeneration()
    // Zoomed in (or a tall image), the picture on screen is not the one the thumbnail shows.
    if (!morph || !zoom.snapshot().fitted) return setClosing({ generation, to: { outer: { opacity: 0 }, inner: LANDED.inner }, timing: { duration: DURATION.quick, ease: bezier(EASE.out) } })
    const now = source()
    if (onScreen(now?.rect, window)) return setClosing({ generation, to: morphFrom(now!, rect, clip, area), timing: MORPH_CLOSE })
    setClosing({ generation, to: fallbackTo(now ?? from!, window, rect, clip, area), timing: MORPH_CLOSE })
  }
  // A hidden window has no native frames, so a pending exit would never complete.
  useEffect(() => { if (closing && !isWindowVisible()) finish() })
  // The exit normally ends on the image's `onMotionComplete`; this only guarantees the unmount if it never reports
  // (ADE-70: a closed preview that stayed mounted took every click in the window).
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(finish, closing.timing.duration * 1000 + 250)
    return () => clearTimeout(timer)
  }, [closing])
  // A keyboard open has no transform yet, so the exit names its start: from `false` there is nothing to animate.
  const shown = !!(start || fadeIn)

  // The morph scales about the fitted picture's centre, which is not the room's.
  const origin: [number, number] = [home.x / area.width, home.y / area.height]
  const outer: PaintTransformProps | undefined = closing
    ? { initial: shown ? false : LANDED.outer, animate: closing.to.outer, transition: closing.timing, generation: closing.generation, origin }
    : start ? { initial: start.outer, animate: LANDED.outer, transition: MORPH_OPEN, retain: true, origin }
    : fadeIn ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: bezier(EASE.smoothOut) }, retain: true }
    : undefined
  const inner: PaintTransformProps | undefined = !clip || !PATCHED_NATIVE ? undefined : closing
    ? { initial: false, animate: closing.to.inner, transition: closing.timing, generation: closing.generation }
    : { initial: start?.inner ?? false, animate: LANDED.inner, transition: MORPH_OPEN }
  // The scrim and the toolbar follow the image's timing, both ways. Under Reduce Motion everything is one 150 ms fade.
  const scrim: PaintTransformProps | undefined = !PATCHED_NATIVE || (!from && !closing) ? undefined : closing
    ? { initial: from ? false : { opacity: 1 }, animate: { opacity: 0 }, transition: closing.timing }
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: morph ? MORPH_OPEN : { duration: DURATION.quick, ease: bezier(EASE.smoothOut) } }
  const nudge = REDUCED_MOTION ? 0 : -DISTANCE.micro
  const chrome: PaintTransformProps | undefined = !PATCHED_NATIVE || (!from && !closing) ? undefined : closing
    ? { initial: from ? false : { opacity: 1, translateY: 0 }, animate: { opacity: 0, translateY: nudge }, transition: closing.timing }
    : { initial: { opacity: 0, translateY: nudge }, animate: { opacity: 1, translateY: 0 }, transition: morph ? MORPH_OPEN : { duration: DURATION.quick, ease: bezier(EASE.smoothOut) } }
  const outline = t.variant === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'
  return (
    // An anchored layer paints an opaque backing unless it asks for none (`backdrop: { blur: 0 }`); the scrim is our own
    // child so it can fade. The web occlusion keeps an embedded browser preview under the scrim.
    // Closing, it lets clicks through at once: the window behind is live again before the fade ends.
    <anchored backdrop={{ blur: 0 }} position={{ x: 0, y: 0 }} fit="snap" snapMargin={0} deferred priority={4} occlude={!closing}>
      <div testId={web.id} style={{ display: 'flex' }}>
      <div ref={root} testId={testId} tabIndex={0} autoFocus
        onKeyDown={(e: { key?: string; modifiers?: { shift?: boolean; cmd?: boolean; ctrl?: boolean; alt?: boolean }; preventDefault(): void; stopPropagation?(): void }) => {
          // Escape closes the preview, zoomed or not (Quick Look's rule; ⌘0 fits). The keys it takes stop here: the window's
          // handlers and the cards around the thumbnail must not see them (an empty composer's Escape cancels the agent's turn
          // while a request is pending, and the preview hands focus back to that composer as it closes).
          if (e.key === 'escape' && !kitOverlayOpen()) { e.preventDefault(); e.stopPropagation?.(); close(true) }
          // ⌘+ ⌘− ⌘0 zoom the picture (`ZoomController.key`).
          else if (zoom.key(e)) { e.preventDefault(); e.stopPropagation?.() }
          // Modal while open: Tab and Shift-Tab wrap among its own stops instead of reaching the window behind it.
          // The window's own Tab navigation would move focus a second time, behind the modal.
          else if (e.key === 'tab' && root.current) { e.preventDefault(); (e.modifiers?.shift ? renderer.focusPreviousWithin : renderer.focusNextWithin)?.call(renderer, root.current.id) }
        }}
        style={{ position: 'relative', width: window.width, height: window.height, pointerEvents: closing ? 'none' : undefined }}
      >
      {/* The scrim takes outside clicks; the image, then the toolbar, sit above it. */}
      <div testId={`${testId}-scrim`} onClick={() => close(false)} paintTransform={scrim} style={{ position: 'absolute', left: 0, top: 0, width: window.width, height: window.height, backgroundColor: SCRIM }} />
      <div
        testId={`${testId}-image`}
        paintTransform={outer}
        onMotionComplete={e => { if (closing && e.motionGeneration === closing.generation) finish() }}
        style={{ position: 'absolute', left: area.x, top: area.y, width: area.width, height: area.height }}
      >
        {/* The lift shadow stays outside the clip and fades in as the image lands (`shadowOpacity`). */}
        <LiftShadow controller={zoom} box={{ x: rect.x - area.x, y: rect.y - area.y, width: rect.width, height: rect.height }} />
        <div paintTransform={inner} style={{ position: 'absolute', left: 0, top: 0, width: area.width, height: area.height, display: 'flex', overflow: 'hidden' }}>
          <ZoomSurface controller={zoom} src={src} label={label} radius={PREVIEW_RADIUS} outline={outline} onBackdrop={() => close(false)} testId={`${testId}-zoom-surface`} />
        </div>
      </div>
      {/* After the image: the zoom room spans the whole area under the toolbar's top, so a toolbar drawn before it sat under
        its backdrop, and every button press closed the preview. Later siblings paint and take the pointer first. */}
      <div testId={`${testId}-bar`} paintTransform={chrome} style={{ position: 'absolute', left: rect.x, top: rect.y - BAR - GAP, width: rect.width, height: BAR, display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 16, paddingRight: onOpenInTab ? 148 : 116, borderRadius: 14, borderWidth: 1, borderColor: t.borderLight, backgroundColor: t.popover }}>
        <Label color={t.text} size={13} weight={500} truncate style={{ flexShrink: 1, minWidth: 0 }}>{label}</Label>
        <ZoomHud controller={zoom} compact={rect.width < 520} testId={`${testId}-zoom`} />
        <ImageActions source={src} label={label} />
        {onOpenInTab && <div testId={`${testId}-open-tab`} role="button" aria-label="Open in tab" tabIndex={0} onClick={() => { onOpenInTab(); close(true) }}
          onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === 'space') { onOpenInTab(); close(true) } }}
          style={{ position: 'absolute', top: 10, right: 108, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonTertiaryHover } }}>
          <Icon source={OPEN_TAB} size={14} color={t.iconSecondary} />
        </div>}
        <div testId={`${testId}-close`} role="button" aria-label="Close preview" tabIndex={0} onClick={() => close(false)}
          onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === 'space') close(true) }}
          style={{ position: 'absolute', top: 10, right: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonTertiaryHover } }}>
          <Icon source={N.x} size={14} color={t.iconSecondary} />
        </div>
      </div>
      </div>
      </div>
    </anchored>
  )
}

/** The picture's lift shadow, under it at fit and gone once it is zoomed (the picture then fills the room). */
function LiftShadow({ controller, box }: { controller: ZoomController; box: Rect }) {
  const zoomed = useZoomSnapshot(controller).zoomed
  const paint: PaintTransformProps | undefined = PATCHED_NATIVE ? { initial: false, animate: { opacity: zoomed ? 0 : 1 }, transition: { duration: REDUCED_MOTION ? 0 : DURATION.quick, ease: bezier(EASE.out) }, retain: true } : undefined
  return <div paintTransform={paint} style={{ position: 'absolute', left: box.x, top: box.y, width: box.width, height: box.height, borderRadius: PREVIEW_RADIUS, boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 50, spreadRadius: -12, color: 'rgba(0, 0, 0, 0.6)' } }} />
}

/** A thumbnail that opens the shared preview: the box `useMorphSource` reads, hidden while its image is in the preview. */
export function useImageViewer({ radius, fit }: { radius: number; fit: MorphSource['fit'] }) {
  const { node, source } = useMorphSource({ radius, fit })
  const [open, setOpen] = useState<{ from: MorphSource | null } | null>(null)
  return {
    node,
    source,
    open,
    /** Pointer: morph from the thumbnail. Keyboard: instant. */
    show: (pointer: boolean) => setOpen({ from: pointer ? source() : null }),
    hide: () => setOpen(null),
    /** The thumbnail is away while its image morphs (Reduce Motion cross-fades and keeps it). */
    away: !!open?.from && PATCHED_NATIVE && !REDUCED_MOTION,
  }
}

