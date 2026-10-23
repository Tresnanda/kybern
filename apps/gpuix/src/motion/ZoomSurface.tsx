// The zoomable image, shared by the lightbox (`ImageMorph.tsx`) and the image tab (`tabs/Body.tsx`).
//
// One image node is laid out once, at fit, and everything after that is a `paintTransform` on it (scale + translate about its
// top-left): a wheel event or a drag re-renders only this surface and the HUD, never lays anything out, and never touches the
// rest of the window. Input is `onScroll` (two-finger scroll pans, ⌘-scroll zooms about the pointer), a primary-button drag
// (pans), a double click (fit ↔ 100% at that point) and ⌘+ ⌘− ⌘0 (`ZoomController.key`, wired by the owner of the focus).
// GPUIX 0.11 reports no pinch or magnify gesture to JS, so a trackpad pinch does nothing; ⌘-scroll and the keys stand in.
// The source is always the full image (the preview never swaps in a downscaled copy), so zooming shows its own pixels.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import type { PaintTransformProps } from '@gpuix/native/host'
import { Segmented } from '../kit/Segmented.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { imageSize } from '../transcript/images.tsx'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { useNativeWindowSize } from '../native/layout-hooks.ts'
import { EASE } from './kit.tsx'
import { ZoomController, type ZoomConfig, type ZoomSnapshot } from './zoomController.ts'

const bezier = (e: readonly number[]) => [...e] as [number, number, number, number]

/** One controller for as long as the owner lives; configured on every render. */
export function useZoomController(config: ZoomConfig): ZoomController {
  const ref = useRef<ZoomController | null>(null)
  ref.current ??= new ZoomController()
  ref.current.configure(config)
  return ref.current
}

/** The controller's state, for the components that paint it (the surface, the HUD). */
export function useZoomSnapshot(controller: ZoomController): ZoomSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.snapshot)
}

interface PointerEvent { x?: number; y?: number; button?: number; clickCount?: number; pressedButton?: number; deltaX?: number; deltaY?: number; precise?: boolean; modifiers?: { cmd?: boolean; ctrl?: boolean } }

/**
 * The viewport: fills its parent (which gives it its size and clips it) and holds the stage. `onBackdrop` runs for a click on
 * the empty space around a small image, so a lightbox still closes when it is clicked outside the picture.
 */
export function ZoomSurface({ controller, src, label, radius, outline, onBackdrop, testId = 'zoom-surface' }: { controller: ZoomController; src: string; label: string; radius: number; outline: string; onBackdrop?: () => void; testId?: string }) {
  const renderer = useGpuixRequired()
  const snap = useZoomSnapshot(controller)
  const view = snap.limits
  if (!snap.enabled || !view) {
    // The image's size is unknown (a format the header reader does not know): it is shown fitted and does not zoom.
    return <div testId={testId} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, display: 'flex' }}>
      <img src={src} alt={label} objectFit="contain" style={{ width: '100%', height: '100%', borderRadius: radius, borderWidth: 1, borderColor: outline }} />
    </div>
  }
  const { stage } = snap
  const transition = { duration: snap.duration, ease: bezier(EASE.out) }
  const paint: PaintTransformProps | undefined = PATCHED_NATIVE
    ? { initial: false, animate: snap.transform, transition, origin: [0, 0], retain: true }
    : undefined
  return <div testId={testId}
    onScroll={(e: PointerEvent) => { if (e.x !== undefined && e.y !== undefined) controller.wheel({ x: e.x, y: e.y, deltaX: e.deltaX ?? 0, deltaY: e.deltaY ?? 0, precise: e.precise !== false, modifiers: e.modifiers }) }}
    onMouseDown={(e: PointerEvent) => { if (e.button === 0 && e.x !== undefined && e.y !== undefined) controller.pointerDown(e.x, e.y) }}
    onMouseMove={(e: PointerEvent) => { if (e.x !== undefined && e.y !== undefined) controller.pointerMove(e.x, e.y, e.pressedButton === 0) }}
    onMouseUp={() => controller.pointerUp()}
    onMouseLeave={() => controller.pointerUp()}
    onClick={(e: PointerEvent) => {
      if (e.x === undefined || e.y === undefined) return
      if (controller.click(e.x, e.y, e.clickCount ?? 1) === 'outside') onBackdrop?.()
    }}
    style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, overflow: 'hidden', cursor: snap.dragging ? 'grabbing' : snap.zoomed ? 'grab' : 'default' }}>
    <div testId={`${testId}-stage`} paintTransform={paint}
      style={{ position: 'absolute', left: stage.x, top: stage.y, width: stage.width, height: stage.height }}>
      <img src={src} alt={label} objectFit="contain" style={{ width: stage.width, height: stage.height, borderRadius: radius, borderWidth: 1, borderColor: outline, pointerEvents: 'none' }} />
    </div>
  </div>
}

/** The zoom readout and the fit / 100% toggle (`Segmented`: neither is selected while the zoom is somewhere between). */
export function ZoomHud({ controller, compact = false, testId = 'zoom-hud' }: { controller: ZoomController; compact?: boolean; testId?: string }) {
  const t = useTheme()
  const snap = useZoomSnapshot(controller)
  if (!snap.enabled) return null
  const value = snap.fitted ? 'fit' : snap.actual ? 'actual' : ''
  return <div testId={testId} style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
    <div style={{ display: 'flex', minWidth: 36, justifyContent: 'flex-end' }}>
      <div testId={`${testId}-percent`}><Label color={t.textSecondary} size={12}>{`${snap.percent}%`}</Label></div>
    </div>
    {!compact && <Segmented size="sm" aria-label="Zoom" testId={`${testId}-toggle`} value={value}
      options={[{ value: 'fit', label: 'Fit' }, { value: 'actual', label: '100%' }]}
      onChange={next => { if (next === 'fit') controller.fit(); else controller.zoomTo(snap.limits!.actual, undefined, true) }} />}
  </div>
}

/** The image tab's margin around the fitted picture. */
const TAB_PAD = 24

/**
 * An image filling a pane (the image tab): the surface, the HUD floating at its top right, and ⌘+ ⌘− ⌘0 through `keys` (the
 * document host registers the handler it calls for keys while the tab has focus).
 */
export function ZoomPane({ src, label, keys }: { src: string; label: string; keys?: { current: ((event: { key?: string; modifiers?: { cmd?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } }) => boolean) | null } | null }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const node = useRef<PublicInstance | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  // The header is read once per source (a local file is a disk read; a large data URI is not cached by `imageSize`).
  const size = useMemo(() => imageSize(src), [src])
  const scaleFactor = useNativeWindowSize().scaleFactor
  const controller = useZoomController({
    image: size, viewport: box, scaleFactor, pad: TAB_PAD, reduced: REDUCED_MOTION,
    origin: () => { const b = node.current ? renderer.getElementBounds?.(node.current.id) : null; return b ? { x: b.x, y: b.y } : { x: 0, y: 0 } },
  })
  useEffect(() => {
    if (!keys) return
    keys.current = event => controller.key(event)
    return () => { keys.current = null }
  }, [keys, controller])
  const outline = t.variant === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'
  return <div ref={node} testId="image-tab-pane" onLayout={e => { if (e.width !== undefined && e.height !== undefined) setBox(old => old.width === e.width && old.height === e.height ? old : { width: e.width!, height: e.height! }) }}
    style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0, position: 'relative', overflow: 'hidden' }}>
    {box.width > 0 && <ZoomSurface controller={controller} src={src} label={label} radius={8} outline={outline} testId="image-tab-zoom" />}
    <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', alignItems: 'center', padding: 4, paddingLeft: 10, borderRadius: 12, borderWidth: 1, borderColor: t.borderLight, backgroundColor: t.popover }}>
      <ZoomHud controller={controller} testId="image-tab-zoom-hud" />
    </div>
  </div>
}
