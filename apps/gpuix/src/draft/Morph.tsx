// The new chat's send transition, played by the thread page it opens (ADE-62 round 1 §7, round 2 §3). The composer the user
// typed into becomes the thread's composer: it mounts at its rest position and sinks there from the draft's card (paint-only
// translate). The prompt rises into the first user bubble as a stand-in drawn over everything, and attached images ride along
// onto the bubble's thumbnails; both land on the real row, which mounts invisible at its final place and shows itself in the
// frame the stand-in leaves. The headline and pick-up dissolve where they were, and the tray tucks under the card.
//
// Everything that moves is `paintTranslate` / `paintTransform` (tier 1: no React or layout per frame). One critically damped
// spring (0.45 s, no bounce) drives the composer, the text and the images, so they read as one gesture splitting in two.
// Reduce Motion: nothing travels or blurs; the old content fades out and the new fades in over 150 ms.
import type { PaintTransformProps } from '@gpuix/native/host'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { primeAttachmentImage } from '../composer/AttachmentImage.tsx'
import { DURATION, EASE } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { raisedFill, useGlass } from '../platform/glass.ts'
import { FONT_UI } from '../theme.ts'
import { TEXT } from '../transcript/kit.tsx'
import { COLUMN, GUTTER } from '../Transcript.tsx'
import { REDUCED_MOTION, useTheme } from '../ui.tsx'
import { clearFlight, endFlight, startFlight, takeLaunch, useFlightTarget, type Launch } from './store.ts'

type Shift = { translateX: number; translateY: number }
/**
 * The flight: critically damped (no overshoot), interruptible, with a 0.45 s response (ω = 2π / 0.45): 11 % at 40 ms, 36 % at
 * 90, 62 % at 150, 94 % at 320, settled by 450. A `duration: 0.45, bounce: 0` spring settles in 0.45 s and runs about twice as
 * fast early on, so the physical form is spelled out.
 */
const OMEGA = (2 * Math.PI) / DURATION.spring
const FLIGHT = { type: 'spring', stiffness: OMEGA * OMEGA, damping: 2 * OMEGA, mass: 1 } as const
/** The thread composer's card rests 16 above the pane's bottom (`ConversationPage`). */
const REST_INSET = 16
/** How long the page waits for the real bubble's place before the composer goes anyway (the prompt then fades). */
const TARGET_WAIT_MS = 300
/** The editor's line, and the bubble's: padding 6 and a 1 pt border above the first line. */
const EDITOR_LINE = 19.6
const BUBBLE_TOP = 7
/** The bubble's text starts 12 + 1 in from its left edge. */
const BUBBLE_LEFT = 13
/** A one-line prompt this short already fits the bubble: no rewrap, so no crossfade. */
const SHORT_PROMPT = 68

const out = (duration: number) => ({ duration, ease: [...EASE.out] as [number, number, number, number] })

/** What the thread page does with a launch: the composer overlay's motion, its placeholder's entrance, and the layers. */
export interface LaunchMotion {
  overlay?: { paintTranslate?: { initial: Shift; animate: Shift; transition: typeof FLIGHT }; paintTransform?: PaintTransformProps }
  placeholderEnter?: PaintTransformProps
  /** Drawn first inside the composer overlay, above the card, under it in z-order. */
  trayGhost: ReactNode
  /** Drawn under the composer: the dissolving headline and pick-up (their blur must never pass over the moving card). */
  under: ReactNode
  /** Drawn over everything: the prompt and images in flight. */
  over: ReactNode
}

/** Claims this pane's launch for `threadId` once, on mount; null for every ordinary thread open. */
export function useLaunch(paneId: string, threadId: string | null): Launch | null {
  const [launch] = useState(() => {
    const found = PATCHED_NATIVE ? takeLaunch(paneId, threadId) : null
    if (found && (found.text || found.imagesFly) && !REDUCED_MOTION) startFlight(found.threadId)
    // The bubble shows the composer's own copy of each image at once, so a flight lands on the picture, not a loading label.
    if (found) for (const image of found.images) primeAttachmentImage(image.id, image.src)
    return found
  })
  useEffect(() => () => { if (launch) clearFlight(launch.threadId) }, [launch])
  return launch
}

export function useLaunchMotion(launch: Launch | null): LaunchMotion {
  const t = useTheme()
  const flying = !!launch && !REDUCED_MOTION && (!!launch.text || launch.imagesFly)
  const target = useFlightTarget(launch?.threadId ?? '')
  // Wait (briefly) for the real bubble's place, so the text and the composer leave on the same frame.
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    if (!flying) return
    const id = setTimeout(() => setGaveUp(true), TARGET_WAIT_MS)
    return () => clearTimeout(id)
  }, [flying])
  const go = !flying || !!target || gaveUp
  const [exits, setExits] = useState(!!launch)
  const [ghost, setGhost] = useState(!!launch?.tray)
  useEffect(() => {
    if (!launch) return
    // Timers, not motion events: a hidden window delivers no completion, and neither layer may outlive its fade.
    const a = setTimeout(() => setExits(false), 220), b = setTimeout(() => setGhost(false), 180)
    return () => { clearTimeout(a); clearTimeout(b) }
  }, [launch])
  if (!launch) return { trayGhost: null, under: null, over: null }

  const delta = launch.cardTop + launch.cardHeight - (launch.paneHeight - REST_INSET)
  const overlay = REDUCED_MOTION
    ? { paintTransform: { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: out(DURATION.quick) } }
    : { paintTranslate: { initial: { translateX: 0, translateY: delta }, animate: { translateX: 0, translateY: go ? 0 : delta }, transition: FLIGHT }}
  const placeholderEnter: PaintTransformProps = REDUCED_MOTION
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: out(DURATION.quick) }
    // Held while the prompt leaves the card, so it never shows through the departing text.
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { ...out(DURATION.quick), delay: 0.12 } }
  const exitPaint = (dy: number): PaintTransformProps => REDUCED_MOTION
    ? { initial: { opacity: 1 }, animate: { opacity: 0 }, transition: out(DURATION.quick) }
    : { initial: { opacity: 1, translateY: 0, blur: 0 }, animate: { opacity: 0, translateY: dy, blur: 4 }, transition: out(DURATION.quick) }
  const trayGhost = ghost && launch.tray ? (
    <div
      paintTransform={REDUCED_MOTION
        ? { initial: { opacity: 1 }, animate: { opacity: 0 }, transition: out(0.12) }
        : { initial: { opacity: 1, translateY: 0 }, animate: { opacity: 0, translateY: 8 }, transition: out(0.12) }}
      style={{ position: 'absolute', left: 0, right: 0, top: -36, height: 36, display: 'flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'none' }}
    >
      {launch.tray}
    </div>
  ) : null
  const under = (
    <>
      {exits && launch.exit({ headline: exitPaint(-12), pickup: exitPaint(12) })}
      {(launch.textFades || REDUCED_MOTION) && launch.textRect && launch.textValue.trim() && exits && (
        <div
          paintTransform={{ initial: { opacity: 1 }, animate: { opacity: 0 }, transition: out(DURATION.quick) }}
          style={{ position: 'absolute', left: launch.textRect.x, top: launch.textRect.y, width: launch.textRect.width, height: launch.textRect.height, overflow: 'hidden', pointerEvents: 'none' }}
        >
          <text style={{ color: t.text, fontSize: 14, lineHeight: EDITOR_LINE, fontFamily: FONT_UI }}>{launch.textValue}</text>
        </div>
      )}
      {exits && launch.images.length > 0 && (!flying || !launch.imagesFly || (!!target && target.images.length !== launch.images.length)) && launch.images.map((image) => (
        <div
          key={image.id}
          paintTransform={{ initial: { opacity: 1 }, animate: { opacity: 0 }, transition: out(DURATION.quick) }}
          style={{ position: 'absolute', left: image.rect.x, top: image.rect.y, width: image.rect.width, height: image.rect.height, pointerEvents: 'none' }}
        >
          <img src={image.src} objectFit="cover" style={{ width: image.rect.width, height: image.rect.height, borderRadius: 11 }} />
        </div>
      ))}
    </>
  )
  const over = flying ? <Flight launch={launch} go={go} gaveUp={gaveUp && !target} /> : null
  return { overlay, placeholderEnter, trayGhost, under, over }
}

/** The stand-in bubble and the image flyers, landing on the real row. */
function Flight({ launch, go, gaveUp }: { launch: Launch; go: boolean; gaveUp: boolean }) {
  const t = useTheme()
  const g = useGlass()
  const target = useFlightTarget(launch.threadId)
  const [landed, setLanded] = useState(false)
  // The ghost's blur is a pass over whatever is under it (the stand-in): it must leave once faded, not rest at 2 pt.
  const [ghost, setGhost] = useState(true)
  useEffect(() => {
    if (!go) return
    const id = setTimeout(() => setGhost(false), 110)
    return () => clearTimeout(id)
  }, [go])
  const pending = useRef(0)
  const text = launch.text
  // The stand-in's box: its first line centred on the editor's first line, its text on the editor's left edge.
  const start = text ? { x: text.rect.x - BUBBLE_LEFT, y: text.rect.y + EDITOR_LINE / 2 - BUBBLE_TOP - TEXT.lineHeight / 2 } : null
  const column = Math.min(COLUMN, launch.paneWidth - 2 * GUTTER)
  const short = !!text && text.lines === 1 && !text.value.includes('\n') && [...text.value].length <= SHORT_PROMPT
  const toLocal = (r: { x: number; y: number; width: number; height: number }) => ({ ...r, x: r.x - launch.paneX, y: r.y - launch.paneY })
  const textTo = target?.text && start ? toLocal(target.text) : null
  const imagesTo = target?.images.map(toLocal) ?? []
  // The bubble draws a different set of images than the composer held: they fade in place (the layer above) instead.
  const images = launch.imagesFly && (!target || target.images.length === launch.images.length) ? launch.images : []
  const parts = (text ? 1 : 0) + images.length
  // Nothing left to fly once the target is known: show the real row now.
  useEffect(() => { if (target && parts === 0) { setLanded(true); endFlight(launch.threadId) } }, [target, parts, launch.threadId])
  const land = () => {
    if (++pending.current < parts) return
    setLanded(true)
    endFlight(launch.threadId)
  }
  // No place to land: fade the stand-in out and let the real row show.
  useEffect(() => {
    if (!gaveUp) return
    const id = setTimeout(() => { setLanded(true); endFlight(launch.threadId) }, 150)
    return () => clearTimeout(id)
  }, [gaveUp, launch.threadId])
  if (landed) return null
  const fill = raisedFill(g, t.variant === 'dark' ? t.composer : 'rgba(255, 255, 255, 0.743)')
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none' }} paintTransform={gaveUp ? { initial: { opacity: 1 }, animate: { opacity: 0 }, transition: out(DURATION.quick) } : undefined}>
      {text && start && (
        <div
          paintTranslate={{
            initial: { translateX: 0, translateY: 0 },
            animate: go && textTo ? { translateX: textTo.x - start.x, translateY: textTo.y - start.y } : { translateX: 0, translateY: 0 },
            transition: FLIGHT,
          }}
          onMotionComplete={() => { if (go && textTo) land() }}
          style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
        >
          {/* The stand-in: `UserBubble`'s text box (fill = the composer's own, so it shows only as it clears the card). */}
          <div style={{ position: 'absolute', left: start.x, top: start.y, display: 'flex', maxWidth: column * 0.8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6, borderRadius: 12.8, borderWidth: 1, borderColor: 'rgba(0, 0, 0, 0)', backgroundColor: fill, minWidth: 0 }}>
              <div paintTransform={short ? undefined : { initial: { opacity: 0, blur: 2 }, animate: go ? { opacity: 1, blur: 0 } : { opacity: 0, blur: 2 }, transition: out(0.09) }} style={{ display: 'flex', flexDirection: 'column' }}>
                <text style={{ color: t.text, fontSize: TEXT.size, lineHeight: TEXT.lineHeight, fontFamily: FONT_UI }}>{text.value}</text>
              </div>
            </div>
          </div>
          {/* The ghost, drawn over the stand-in (whose fill would hide it): the editor's own wrap, leaving with a 2 pt blur while the bubble's wrap settles in over it (90 ms). */}
          {!short && ghost && (
            <div
              paintTransform={{ initial: { opacity: 1, blur: 0 }, animate: go ? { opacity: 0, blur: 2 } : { opacity: 1, blur: 0 }, transition: out(0.09) }}
              style={{ position: 'absolute', left: text.rect.x, top: text.rect.y, width: text.rect.width }}
            >
              <text style={{ color: t.text, fontSize: 14, lineHeight: EDITOR_LINE, fontFamily: FONT_UI }}>{text.value}</text>
            </div>
          )}
        </div>
      )}
      {images.map((image, i) => {
        const to = imagesTo[i]
        const scale = to ? to.width / image.rect.width : 1
        return (
          <div
            key={image.id}
            paintTranslate={{
              initial: { translateX: 0, translateY: 0 },
              animate: go && to ? { translateX: to.x - image.rect.x, translateY: to.y - image.rect.y } : { translateX: 0, translateY: 0 },
              transition: FLIGHT,
            }}
            onMotionComplete={() => { if (go && to) land() }}
            style={{ position: 'absolute', left: image.rect.x, top: image.rect.y, width: image.rect.width, height: image.rect.height }}
          >
            {/* Scale about the top-left on the same clock as the spring's settle, from the tile's 62 to the thumbnail's size. */}
            <div paintTransform={{ initial: false, animate: { scale: go && to ? scale : 1 }, origin: [0, 0], transition: { duration: DURATION.spring, ease: [...EASE.smoothOut] } }} style={{ display: 'flex', width: image.rect.width, height: image.rect.height }}>
              <img src={image.src} objectFit="cover" style={{ width: image.rect.width, height: image.rect.height, borderRadius: 11 }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
