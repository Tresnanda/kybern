// An agent's inline HTML visual (ADE-69, A′): a borderless figure on the thread with a caption line under it.
//
// A visual on screen is live: its web document (`visualDocs.ts`) sits over the figure's exact rect, so the first press
// lands on the page itself. Off screen, or past the few that may be live at once (`liveSlot`), it is a picture the daemon
// drew (`visualPicture.ts`): a GPUI image that scrolls, clips and fades like any row and costs no web process. The figure
// is as tall as its page (up to 20,000 px): the page's own posted height wins, and each visual remembers its last one,
// so a remount or the picture↔page switch never moves the chat. The page never scrolls itself; the native host hands
// the wheel to the chat except over the page's own scroll areas (`webview.m`, `webview-win`, `webview-linux.c`). A page
// that leaves the screen hides warm; one that must make room freezes (`snapshot`) into the picture first. Under the
// composer the page is cut out and its picture shows through the glass. "Open in a tab" and "Full screen" (ADE-80)
// hand the same document over, so its state survives. A visual that asks (`await_answer`) draws the answer bar under it
// instead of the caption (`VisualAnswer.tsx`).
import { memo, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { readFile } from 'node:fs/promises'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { ChartHistogramIcon, FullScreenIcon, RefreshIcon, SquareArrowExpand01Icon } from '@hugeicons/core-free-icons'
import type { HtmlVisual, JsonValue, VisualAnswerRecord } from '../../../../packages/kybern-client/src/types.ts'
import { clampVisualHeight, visualFrameHeight, VISUAL_COLUMN_WIDTH, type VisualTheme } from '../../../../packages/kybern-client/src/visuals.ts'
import { usePaneAccess, callThread } from '../state.ts'
import { openTabFromPane } from '../tabs/open.ts'
import { useChatHidden } from '../tabs/hidden.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { useControls } from '../kit/controls.ts'
import { glyph, Icon, ICONS } from '../icons.tsx'
import { T } from './glyphs.ts'
import { Dialog, Menu, MenuItem, MenuSeparator, Tip, useDialogClose } from '../nav/overlay.tsx'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { webHost } from '../native/webview.ts'
import { WebSurface, WEB_SURFACE_HOST } from '../native/WebSurface.tsx'
import { observeElementBounds, type ElementBoundsEvent, type LayoutRect } from '../native/layout.ts'
import { useNativeWindowSize } from '../native/layout-hooks.ts'
import { useWebLayer } from '../native/web-occlusion.ts'
import { visualTheme } from '../preview/theme.ts'
import { useNav } from '../nav/store.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { DURATION, EASE, HOVER_FADE, webDocumentEnter } from '../motion/kit.tsx'
import { REDUCED_MOTION } from '../ui.tsx'
import { copyImage, saveImageFile } from '../platform/files.ts'
import { toast } from '../shell/toasts.tsx'
import { copyText } from './store.ts'
import { composerCardRects } from '../composer/height.ts'
import { focusThreadComposer } from '../composer/focus.ts'
import { imageCachePath } from './imageFiles.ts'
import { usePicture, type Picture } from './visualPicture.ts'
import { claimDoc, docId, docState, freezeDoc, listenDoc, liveSlot, releaseDoc, reloadDoc, subscribeDocs, themeDoc, type DocOwner } from './visualDocs.ts'
import { useTranscriptRowLease } from './Window.tsx'
import { AnswerBar, AnswerReceipt, registerAnswerReveal, setAnswerOnScreen, useVisualAnswer, type VisualAsk } from '../requests/VisualAnswer.tsx'
import { FONT_MONO } from '../theme.ts'
import { OpenInBrowserButton, VisualStill } from './VisualStill.tsx'
import { visualMode } from './visualFallback.ts'
import { isPrimary } from '../platform/keys.ts'

/** With no embedded web view a visual stays a picture: no live page, no tab, and its controls open in the browser (`visualFallback.ts`). */
const LIVE = visualMode(webHost.available) === 'live'
/** Linux paints the page inside GPUI's scene (`<websurface>`): the composer's glass already covers it, so no cut-out. */
const SCENE_PAGES = webHost.surfaceLibrary !== null
const CHART = glyph(ChartHistogramIcon)
const RELOAD = glyph(RefreshIcon)
const FULL_SCREEN = glyph(FullScreenIcon)
/** The image viewer's Open in tab glyph, so it is not mistaken for Full screen. */
const OPEN_TAB = glyph(SquareArrowExpand01Icon)
/** The daemon draws at most this much of a page (`PICTURE_MAX_HEIGHT`); a taller page shows its top until it is live. */
const PICTURE_MAX = 6000
/** A live page taller than this goes back to the daemon's picture instead of a frozen frame (a frame that size is ~100 MB). */
const FREEZE_MAX = 3000
/** Under this column width the caption keeps only Full screen, Open in a tab and ⋯. */
const NARROW = 560
/** A reversible paint-only fade (retained, so every later change is paint-only too). */
const fade = (on: boolean, duration: number = HOVER_FADE.duration) => PATCHED_NATIVE
  ? { initial: false as const, animate: { opacity: on ? 1 : 0 }, transition: { duration: REDUCED_MOTION ? Math.min(duration, 0.09) : duration, ease: [...EASE.out] as [number, number, number, number] }, retain: true }
  : undefined
/** The stock addon has no paint transforms: the same state as plain opacity. */
const still = (on: boolean) => PATCHED_NATIVE ? {} : { opacity: on ? 1 : 0 }

/** The page's theme for pictures and live documents: the app's tokens and fonts on a transparent page. */
export function figureTheme(t: Theme): VisualTheme {
  const theme = visualTheme(t)
  theme.variables['--background'] = 'transparent'
  theme.variables['--font-sans'] = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif'
  theme.variables['--font-mono'] = `"JetBrains Mono", "SF Mono", ${FONT_MONO}, Menlo, monospace`
  return theme
}

/** Each visual's last measured page height, so a remount and the picture↔page switch keep the figure's height. */
const heights = new Map<string, number>()
const HEIGHTS = 512
function rememberHeight(id: string, height: number) {
  heights.delete(id); heights.set(id, height)
  while (heights.size > HEIGHTS) heights.delete(heights.keys().next().value!)
}

const placements = new Map<string, () => void>()

/** Places the visual's document over this box while `active`. Only the slot that placed it hides it again, so the
 * inline figure and the tab can hand one document between them without either hiding the other's placement. */
export function VisualSlot({ id, height, active, radius = 0 }: { id: string; height: number; active: boolean; radius?: number }) {
  const renderer = useGpuixRequired(), ref = useRef<PublicInstance | null>(null), layer = useWebLayer(), slot = useId()
  useEffect(() => {
    if (!ref.current || !active) return
    let latest: ElementBoundsEvent | undefined
    const place = () => {
      const rect = latest?.rect, clip = latest?.clippedRect
      if (!rect || !clip) { webHost.hide(id); return }
      webHost.place(id, rect, clip, { width: rect.width, height: rect.height, scale: 1, left: 0, top: 0, radius, roundedClips: latest?.roundedClips, slot }, true, layer)
    }
    placements.set(id, place)
    const stop = observeElementBounds(renderer, ref.current.id, bounds => { latest = bounds; place() })
    // The native host is created once the frame ticket arrives, often after the box was first placed (a place for a
    // host that does not exist yet is dropped): place it again when it exists, or the page stays blank and unclickable.
    const unsubscribe = webHost.subscribe(event => { if (event.id === id && (event.type === 'created' || event.type === 'loaded') && placements.get(id) === place) place() })
    return () => { stop(); unsubscribe(); if (placements.get(id) === place) { placements.delete(id); webHost.hide(id) } }
  }, [renderer, id, layer, active, radius, slot])
  return <div ref={ref} testId="visual-frame" style={{ height, width: '100%', flexShrink: 0, ...WEB_SURFACE_HOST }}>{active && <WebSurface id={id} slot={slot} />}</div>
}

/** The document's owner and readiness, as one stable value per change. */
function useDoc(id: string) {
  const raw = useSyncExternalStore(subscribeDocs, () => { const d = docState(id); return d ? `${d.owner ?? ''}|${d.ready ? 1 : 0}|${d.error}` : '' })
  if (!raw) return { owner: null, ready: false, error: '' }
  const [owner, ready, ...error] = raw.split('|')
  return { owner: (owner || null) as DocOwner | null, ready: ready === '1', error: error.join('|') }
}

type Hit = { x: number; y: number; w: number; h: number; r: number }
/** Where the composer's stack covers the figure, in the figure's own coordinates (its page is cut out there). */
type Under = { top: number; left: number; right: number }
let frames = 0

export const VisualCard = memo(function VisualCard({ visual, threadId, answer }: { visual: HtmlVisual; threadId: string; answer?: VisualAnswerRecord | null }) {
  const t = useTheme(), c = useControls(), renderer = useGpuixRequired()
  const pane = usePaneAccess()
  const id = docId(threadId, visual.id)
  const theme = useMemo(() => figureTheme(t), [t])
  const doc = useDoc(id)
  const ask = useVisualAnswer(visual, answer ?? null)
  const lock = answer?.status === 'answered' ? { state: 'answered', answer: answer.answer ?? null } : null
  const [box, setBox] = useState<LayoutRect | null>(null)
  const width = box ? Math.round(box.width) : null
  const { picture, error: pictureError, retry: retryPicture } = usePicture(threadId, visual.id, width, theme, lock)
  const [frozen, setFrozen] = useState<{ path: string; height: number } | null>(null)
  const [fullScreen, setFullScreen] = useState(false)
  const [hover, setHover] = useState(false), [focus, setFocus] = useState(false), [menuOpen, setMenuOpen] = useState(false)
  const [hit, setHit] = useState<Hit | null>(null)
  const [liveHeight, setLiveHeight] = useState<number | null>(() => heights.get(id) ?? null)
  /** The picture under a live document is hidden once the document has faded in (the page is transparent). */
  const [covered, setCovered] = useState(false)
  const [returning, setReturning] = useState(false)
  /** `liveSlot`'s decision: on screen and among the few that may be live. */
  const [wanted, setWanted] = useState(false)
  const [under, setUnder] = useState<Under | null>(null)
  const pendingPress = useRef<{ x: number; y: number } | null>(null)
  const figure = useRef<PublicInstance | null>(null)
  const freezeToken = useRef(0)
  const onScreen = useRef(false)
  /** Retired to make room for a tab or the viewer: stays a picture until it leaves the screen, so two never trade places. */
  const benched = useRef(false)
  const hidden = useChatHidden()
  const shown = useNav(state => state.page === 'home' && !state.settingsOpen) && !hidden

  const inline = doc.owner === 'inline'
  const live = inline && doc.ready
  const inTab = doc.owner === 'tab'
  // The picture's height at this width (a page taller than the picture shows its top); the figure's height is the page's
  // own last posted height, else that, else the daemon's measured height (no jump when either arrives).
  const scale = picture && width ? width / picture.width : 1
  const pictureHeight = picture ? Math.round(picture.height * scale) : null
  const height = clampVisualHeight(liveHeight ?? (picture && picture.height < PICTURE_MAX ? pictureHeight! : visualFrameHeight(visual, width ?? VISUAL_COLUMN_WIDTH)))
  const failed = !picture && !!pictureError
  const loading = !picture && !pictureError
  const narrow = (width ?? VISUAL_COLUMN_WIDTH) < NARROW
  const canLive = LIVE && !failed && shown

  // Theme changes reach a live or warm document at once.
  useEffect(() => { themeDoc(id, theme) }, [id, theme])
  // A new picture (theme, width or the answered look) replaces a frozen frame.
  useEffect(() => { if (!live && !returning) setFrozen(null) }, [picture?.path])

  const reveal = () => {
    webDocumentEnter(id, webHost.present)
    setTimeout(() => setCovered(true), DURATION.quick * 1000)
    const press = pendingPress.current
    pendingPress.current = null
    if (press) setTimeout(() => webHost.send(id, { kind: 'kybern-visual-click', x: press.x, y: press.y }), 30)
    if (lock) webHost.send(id, { kind: 'kybern-visual-lock', ...lock })
  }
  const claim = () => {
    if (!LIVE || docState(id)?.owner) return
    const wasReady = docState(id)?.ready
    claimDoc(threadId, visual.id, 'inline', theme)
    if (wasReady && docState(id)?.owner === 'inline') reveal()
  }
  const finishReturn = () => {
    freezeToken.current = 0
    setCovered(false)
    releaseDoc(id, 'inline')
    setReturning(false)
  }
  /** Back to the picture. Off screen it simply hides; on screen it freezes into the picture first, pixel for pixel. */
  const rest = () => {
    if (docState(id)?.owner !== 'inline' || returning) return
    if (!docState(id)?.ready || !onScreen.current || height > FREEZE_MAX) { setFrozen(null); finishReturn(); return }
    setReturning(true)
    const token = freezeToken.current = freezeDoc(id, imageCachePath(`visual-frame-${process.pid}-${++frames}.png`))
    // A frame that does not arrive in time: show the daemon picture instead.
    setTimeout(() => { if (freezeToken.current === token) finishReturn() }, 600)
  }
  // Handlers registered once (the key handler, the bounds observer) call the current one.
  const restRef = useRef(rest); restRef.current = rest

  // Live while on screen: `liveSlot` picks the few figures with the most of themselves visible.
  const slot = useRef<ReturnType<typeof liveSlot> | null>(null)
  useEffect(() => { const claim = liveSlot(id, setWanted); slot.current = claim; return () => { claim.release(); slot.current = null } }, [id])
  useEffect(() => {
    if (wanted && canLive && !doc.owner) claim()
    else if ((!wanted || !canLive) && inline) rest()
  }, [wanted, canLive, doc.owner])

  useEffect(() => listenDoc(id, message => {
    switch (message.kind) {
      case 'ready': if (docState(id)?.owner === 'inline') { if (message.height) { setLiveHeight(message.height); rememberHeight(id, message.height) } reveal() } return
      case 'size': setLiveHeight(message.height); rememberHeight(id, message.height); return
      // Esc the page left unhandled: the keyboard goes back to the composer; the page stays live.
      case 'escape': if (docState(id)?.owner === 'inline') { webHost.releaseFocus(); focusThreadComposer(pane.id) } return
      case 'retire': benched.current = true; slot.current?.update(0); rest(); return
      case 'press': ask.interacted(); return
      case 'snapshot':
        if (message.token !== freezeToken.current) return
        // A hand-off (tab, full screen): the frame stands in for the document, which now lives elsewhere.
        if (!returning) { freezeToken.current = 0; if (message.path) setFrozen({ path: message.path, height }); setCovered(false); return }
        if (!message.path) { finishReturn(); return }
        // The frame is shown (covered by the document) first; the document hides once the image has decoded.
        setFrozen({ path: message.path, height })
        setCovered(false)
        return
      case 'draft': ask.draft(message.value, message.label); return
      case 'submit': ask.submit(); return
    }
  }))

  // Esc while GPUI holds the keyboard after a press on the figure: back to the composer.
  useEffect(() => inline ? addWindowKeyHandler(e => { if (e.key === 'escape' && !isPrimary(e.modifiers) && focus) { focusThreadComposer(pane.id); return true } }) : undefined, [inline, focus])
  // The figure's box: its width picks the picture, its visible part claims a live slot, and where the composer's stack
  // covers it the page is cut out and its picture shows through the glass.
  useEffect(() => {
    if (!figure.current) return
    return observeElementBounds(renderer, figure.current.id, e => {
      const r = e.rect
      if (r) setBox(b => b && Math.abs(b.width - r.width) < 1 && Math.abs(b.x - r.x) < 1 && Math.abs(b.y - r.y) < 1 ? b : r)
      const visiblePx = r && e.clippedRect ? Math.max(0, e.clippedRect.height) * Math.min(1, e.clippedRect.width / Math.max(1, r.width)) : 0
      onScreen.current = visiblePx > 0
      if (!visiblePx) benched.current = false
      setAnswerOnScreen(visual.id, !!r && visiblePx / Math.max(1, r.height) > 0.25)
      slot.current?.update(benched.current ? 0 : visiblePx)
      if (!r || SCENE_PAGES) { setUnder(null); return }
      let next: Under | null = null
      for (const card of composerCardRects()) {
        if (card.x >= r.x + r.width || card.x + card.width <= r.x || card.y >= r.y + r.height || card.y + card.height <= r.y) continue
        const top = Math.max(0, card.y - r.y)
        next = { top: next ? Math.min(next.top, top) : top, left: Math.max(0, card.x - r.x), right: Math.max(0, r.x + r.width - card.x - card.width) }
      }
      setUnder(u => (u === next || (u && next && Math.abs(u.top - next.top) < 0.5 && Math.abs(u.left - next.left) < 0.5 && Math.abs(u.right - next.right) < 0.5)) ? u : next)
    })
  }, [renderer, id])
  useEffect(() => registerAnswerReveal(visual.id, () => { if (figure.current) (renderer as { scrollIntoView?: (id: number) => void }).scrollIntoView?.(figure.current.id) }), [renderer, visual.id])
  // Sending closes the full-screen viewer; the answer, once recorded, reaches a live page as its locked look.
  useEffect(() => { if (ask.state === 'sending') setFullScreen(false) }, [ask.state])
  useEffect(() => { if (lock && docState(id)?.ready) webHost.send(id, { kind: 'kybern-visual-lock', ...lock }) }, [answer?.status])
  useEffect(() => () => { setAnswerOnScreen(visual.id, false); if (docState(id)?.owner === 'inline') releaseDoc(id, 'inline') }, [id])

  // The control under the pointer, in page pixels.
  const pageAt = (e: { x?: number; y?: number }) => box && e.x != null && e.y != null ? { x: (e.x - box.x) / scale, y: (e.y - box.y) / scale } : null
  const controlAt = (point: { x: number; y: number } | null, controls: Picture['controls']) =>
    point ? [...controls].reverse().find(k => point.x >= k.x && point.x <= k.x + k.w && point.y >= k.y && point.y <= k.y + k.h) ?? null : null
  const source = frozen?.path ?? picture?.path ?? null
  const sourceHeight = frozen ? frozen.height : pictureHeight ?? height
  const actionsShown = hover || focus || menuOpen

  /** The live document is about to move: freeze it into the figure's picture first (the snapshot routes here). */
  const handOff = () => {
    if (!live) return
    if (height > FREEZE_MAX) { setCovered(false); return }
    const token = freezeToken.current = freezeDoc(id, imageCachePath(`visual-frame-${process.pid}-${++frames}.png`))
    setTimeout(() => { if (freezeToken.current === token) { freezeToken.current = 0; setCovered(false) } }, 600)
  }
  const openTab = () => {
    if (!LIVE) return
    handOff()
    openTabFromPane(pane.id, { kind: 'visual', id: visual.id, title: visual.title || 'Interactive visual' })
  }
  const openFullScreen = () => {
    if (failed || inTab) return
    ask.interacted()
    handOff()
    setFullScreen(true)
  }
  /** A press on the figure before its page is live: the page takes it over and the press is replayed where it landed. */
  const pressPicture = (e: { x?: number; y?: number }) => {
    if (failed || !LIVE) return
    if (inTab) { openTab(); return }
    ask.interacted()
    const point = pageAt(e)
    if (live) { if (point) webHost.send(id, { kind: 'kybern-visual-click', x: point.x, y: point.y }); return }
    pendingPress.current = point
    claim()
  }
  const pictureBytes = async () => { if (!picture) throw Error('The picture is not ready yet.'); return new Uint8Array(await readFile(frozen?.path ?? picture.path)) }
  const copyPicture = () => void pictureBytes().then(bytes => { copyImage(renderer, bytes); toast.success('Image copied') }).catch(() => toast.error('Unable to copy image', { description: 'Use Save image instead, or reload the visual.' }))
  const savePicture = () => void pictureBytes().then(bytes => saveImageFile(renderer, bytes, `${visual.title || 'Visual'}.png`)).catch(() => toast.error('Unable to save image', { description: 'Reload the visual, then try again.' }))
  const copySource = () => void callThread(threadId, 'threads.visuals.read', { thread_id: threadId, visual_id: visual.id }).then(r => { copyText(r.html); toast.success('HTML source copied') }).catch(() => toast.error('Unable to copy the source', { description: 'Check the connection and try again.' }))
  const reload = () => { setFrozen(null); retryPicture(); if (inline) { setCovered(false); reloadDoc(id) } }

  const answerBar = ask.waiting || ask.late
  const toolFocus = { onFocus: () => setFocus(true), onBlur: () => setFocus(false) }
  /** Full screen beside the answer bar and its receipt, which replace the caption that has it. */
  const tools = failed || loading ? null : <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
    {!inTab && <Tip label="Full screen" shortcut={['⇧', '⌘', '↵']} side="top" size={24}><IconButton testId="visual-full-screen" size="sm" icon={FULL_SCREEN} label="Full screen" onClick={openFullScreen} {...toolFocus} /></Tip>}
  </div>
  const picturedHere = covered && under && source && !inTab
  return <div testId="visual-card" data-status={failed ? 'error' : picture ? 'ready' : 'loading'} data-mode={live ? 'live' : inTab ? 'tab' : 'rest'}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setHit(null) }}
    style={{ display: 'flex', flexDirection: 'column', marginTop: 14, marginBottom: 12, position: 'relative' }}>
    {live && <div testId="visual-live" style={{ position: 'absolute', width: 0, height: 0 }} />}
    <div ref={figure} testId="visual-figure" role={LIVE ? 'button' : 'img'} tabIndex={LIVE ? 0 : -1} aria-label={visual.title || 'Interactive visual'}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      onKeyDown={e => { if (e.key === 'enter' && isPrimary(e.modifiers) && e.modifiers?.shift) openFullScreen(); else if (e.key === 'enter' && isPrimary(e.modifiers)) openTab(); else if ((e.key === 'enter' || e.key === 'space') && live) webHost.focus(id) }}
      onMouseMove={LIVE && picture && !inline ? e => setHit(controlAt(pageAt(e), picture.controls)) : undefined}
      onClick={failed || !LIVE || live ? undefined : pressPicture}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', height, overflow: 'hidden', cursor: 'default', opacity: inTab ? 0.38 : 1,
        focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 4 }, borderRadius: 4 }}>
      {source && <div paintTransform={fade(!covered, HOVER_FADE.duration)} style={{ position: 'absolute', left: 0, top: 0, right: 0, height: sourceHeight, pointerEvents: 'none', ...still(!covered) }}>
        <img testId="visual-picture" src={source} alt="" objectFit="fill" onLoad={returning && frozen ? finishReturn : undefined} style={{ width: '100%', height: '100%', pointerEvents: 'none' }} />
      </div>}
      {/* Under the composer the live page is cut out; its picture shows there instead, blurred by the glass. */}
      {picturedHere && <div testId="visual-under-composer" style={{ position: 'absolute', left: under.left, right: under.right, top: under.top, bottom: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <img src={source} alt="" objectFit="fill" style={{ position: 'absolute', left: -under.left, top: -under.top, width: width ?? '100%', height: sourceHeight, pointerEvents: 'none' }} />
      </div>}
      {/* The hit map: the page control under the pointer gets a wash at its own box, so the press visibly reaches it. */}
      {hit && !inline && <div testId="visual-hit" style={{ position: 'absolute', left: hit.x * scale, top: hit.y * scale, width: hit.w * scale, height: hit.h * scale, borderRadius: hit.r * scale, backgroundColor: ink(t, t.variant === 'light' ? 0.06 : 0.07), pointerEvents: 'none' }} />}
      {loading && <div testId="visual-skeleton" role="status" aria-label="Rendering visual" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 10, backgroundColor: ink(t, t.variant === 'light' ? 0.035 : 0.04) }} />}
      {failed && <FigureError title={visual.title} reason={pictureError} onReload={reload} />}
      <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height }}><VisualSlot id={id} height={height} active={inline && shown} /></div>
    </div>
    {answerBar ? <AnswerBar ask={ask} live={live} tools={tools} onReply={() => focusThreadComposer(pane.id)} /> : answer && visual.ask ? <AnswerReceipt record={answer} ask={ask} title={visual.title} tools={tools &&
      <div paintTransform={fade(actionsShown)} style={{ display: 'flex', flexShrink: 0, pointerEvents: actionsShown ? 'auto' : 'none', ...still(actionsShown) }}>{tools}</div>} /> : (
      <div testId="visual-caption" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 24, marginTop: 8, minWidth: 0 }}>
        <Icon source={CHART} size={14} color={t.textTertiary} />
        <Label color={t.textSecondary} size={12} lineHeight={16} weight={500} truncate style={{ flexShrink: 1, minWidth: 0 }}>{visual.title}</Label>
        <div style={{ flexGrow: 1 }} />
        {!LIVE && !loading && !failed && <OpenInBrowserButton threadId={threadId} visualId={visual.id} />}
        {loading && <><Spinner size={12} color={t.textTertiary} /><Label color={t.textTertiary} size={12} lineHeight={16}>Rendering…</Label></>}
        {failed && <Label color={t.red} size={12} lineHeight={16}>Didn’t load</Label>}
        {inTab && <>
          <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accentFg }} />
          <Label color={t.textSecondary} size={12} lineHeight={16}>Live in a tab</Label>
          <Button size="sm" variant="secondary" testId="visual-show-tab" onClick={openTab}>Show tab</Button>
        </>}
        {!loading && !inTab && <div paintTransform={fade(actionsShown || failed)} style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, pointerEvents: actionsShown || failed ? 'auto' : 'none', ...still(actionsShown || failed) }}>
          {!failed && <Tip label="Full screen" shortcut={['⇧', '⌘', '↵']} side="top" size={24}><IconButton testId="visual-full-screen" size="sm" icon={FULL_SCREEN} label="Full screen" onClick={openFullScreen} {...toolFocus} /></Tip>}
          {LIVE && !failed && <Tip label="Open in a tab" shortcut={['⌘', '↵']} side="top" size={24}><IconButton testId="visual-expand" size="sm" icon={OPEN_TAB} label="Open in a tab" onClick={openTab} {...toolFocus} /></Tip>}
          {!narrow && !failed && <Tip label="Copy image" side="top" size={24}><IconButton testId="visual-copy" size="sm" icon={T.copy} label="Copy image" onClick={copyPicture} {...toolFocus} /></Tip>}
          {!narrow && <Tip label="Reload" side="top" size={24}><IconButton testId="visual-reload" size="sm" icon={RELOAD} label="Reload" onClick={reload} {...toolFocus} /></Tip>}
          <Menu testId="visual-more" width={200} align="end" onOpenChange={setMenuOpen} trigger={() => <IconButton size="sm" icon={ICONS.ellipsis} label="More" />}>
            {narrow && !failed && <MenuItem id="copy" label="Copy image" onSelect={copyPicture} />}
            <MenuItem id="save" label="Save image…" disabled={!picture} onSelect={savePicture} />
            <MenuItem id="source" label="Copy HTML source" onSelect={copySource} />
            <MenuSeparator />
            <MenuItem id="reload" label="Reload" onSelect={reload} />
          </Menu>
        </div>}
      </div>
    )}
    {fullScreen && <VisualViewer threadId={threadId} visual={visual} ask={ask} lock={lock} onReply={() => { setFullScreen(false); focusThreadComposer(pane.id) }} onClose={() => setFullScreen(false)}
      onOpenTab={() => { setFullScreen(false); openTabFromPane(pane.id, { kind: 'visual', id: visual.id, title: visual.title || 'Interactive visual' }) }} />}
  </div>
})

/** The figure at the window's size (ADE-80): the same live document in a dialog, with the answer bar when it asks. */
function VisualViewer({ threadId, visual, ask, lock, onReply, onClose, onOpenTab }: { threadId: string; visual: HtmlVisual; ask: VisualAsk; lock: JsonValue | null; onReply: () => void; onClose: () => void; onOpenTab: () => void }) {
  const t = useTheme()
  const theme = useMemo(() => figureTheme(t), [t])
  const size = useNativeWindowSize()
  const id = docId(threadId, visual.id)
  // Its row stays mounted while the viewer is open: the card routes the page's drafts and owns the answer.
  useTranscriptRowLease(true)
  const close = useRef(onClose)
  close.current = () => { webHost.releaseFocus(); onClose() }
  // Escape inside the page closes it, as does the page being retired to make room.
  useEffect(() => listenDoc(id, message => { if (message.kind === 'escape' || message.kind === 'retire') close.current() }), [id])
  const asking = ask.waiting || ask.late
  return <Dialog testId="visual-viewer" width={Math.min(1280, size.width - 64)} radius={16} onClose={() => close.current()}>
    <div style={{ display: 'flex', flexDirection: 'column', height: Math.max(240, size.height - 64) }}>
      <ViewerHeader id={id} title={visual.title || 'Interactive visual'} onOpenTab={onOpenTab} onClose={() => close.current()} />
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingLeft: 24, paddingRight: 24, paddingBottom: asking ? 0 : 24 }}>
        {LIVE ? <VisualTab threadId={threadId} visualId={visual.id} owner="modal" /> : <VisualStill threadId={threadId} visualId={visual.id} theme={theme} lock={lock} testId="visual-viewer-page" />}
      </div>
      {asking && <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, paddingLeft: 16, paddingRight: 16, paddingBottom: 16 }}><AnswerBar ask={ask} live={false} onReply={onReply} /></div>}
    </div>
  </Dialog>
}

function ViewerHeader({ id, title, onOpenTab, onClose }: { id: string; title: string; onOpenTab: () => void; onClose: () => void }) {
  const t = useTheme()
  const exit = useDialogClose()
  // A pointer close plays the dialog's exit; the page, which cannot fade with it, leaves first.
  const closeWithExit = () => { webHost.hide(id); if (exit) exit(onClose); else onClose() }
  return <div testId="visual-viewer-header" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 48, flexShrink: 0, paddingLeft: 18, paddingRight: 10 }}>
    <Icon source={CHART} size={14} color={t.textTertiary} />
    <Label color={t.text} size={13} lineHeight={18} weight={500} truncate style={{ flexShrink: 1, minWidth: 0 }}>{title}</Label>
    <div style={{ flexGrow: 1 }} />
    {LIVE && <Tip label="Open in a tab" side="bottom" size={24}><IconButton testId="visual-viewer-open-tab" size="sm" icon={OPEN_TAB} label="Open in a tab" onClick={() => { webHost.hide(id); onOpenTab() }} /></Tip>}
    <Tip label="Close" shortcut={['esc']} side="bottom" size={24}><IconButton testId="visual-viewer-close" size="sm" icon={T.close} label="Close full screen" onClick={closeWithExit} /></Tip>
  </div>
}

function FigureError({ title, reason, onReload }: { title: string; reason: string; onReload: () => void }) {
  const t = useTheme()
  return <div testId="visual-error" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, paddingLeft: 16, paddingRight: 16, borderRadius: 10, backgroundColor: ink(t, t.variant === 'light' ? 0.035 : 0.04) }}>
    <Icon source={T.alert} size={18} color={t.textSecondary} />
    <Label color={t.text} size={13} weight={500} style={{ textAlign: 'center' }}>{`Couldn’t show “${title}”`}</Label>
    <Label color={t.textSecondary} size={12} lineHeight={17} style={{ textAlign: 'center', maxWidth: 360, lineClamp: 2 }}>{reason}</Label>
    <Button testId="visual-retry" size="sm" variant="secondary" style={{ marginTop: 4 }} onClick={onReload}>Reload</Button>
  </div>
}

/** A visual opened as a tab (ADE-54) or full screen (`owner` modal): the same live document as the inline figure, at
 * the box's size. */
export function VisualTab(props: { threadId: string; visualId: string; owner?: Exclude<DocOwner, 'inline'> }) {
  return LIVE ? <LiveVisualTab {...props} /> : <StaticVisualTab threadId={props.threadId} visualId={props.visualId} />
}
/** Without a web view the tab is the picture and Open in browser. */
function StaticVisualTab({ threadId, visualId }: { threadId: string; visualId: string }) {
  const t = useTheme(), theme = useMemo(() => figureTheme(t), [t])
  return <div testId="visual-tab" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, padding: 16 }}><VisualStill threadId={threadId} visualId={visualId} theme={theme} /></div>
}
function LiveVisualTab({ threadId, visualId, owner = 'tab' }: { threadId: string; visualId: string; owner?: Exclude<DocOwner, 'inline'> }) {
  const t = useTheme()
  const id = docId(threadId, visualId)
  const theme = useMemo(() => figureTheme(t), [t])
  const doc = useDoc(id)
  const shown = useNav(state => state.page === 'home' && !state.settingsOpen)
  useEffect(() => {
    const wasReady = docState(id)?.ready
    claimDoc(threadId, visualId, owner, theme)
    if (wasReady) webDocumentEnter(id, webHost.present)
    return () => releaseDoc(id, owner)
  }, [id, owner])
  useEffect(() => { themeDoc(id, theme) }, [id, theme])
  useEffect(() => listenDoc(id, message => { if (message.kind === 'ready' && docState(id)?.owner === owner) webDocumentEnter(id, webHost.present) }), [id, owner])
  const renderer = useGpuixRequired()
  const [host, setHost] = useState<PublicInstance | null>(null)
  const [height, setHeight] = useState(400)
  useEffect(() => host ? observeElementBounds(renderer, host.id, e => { if (e.rect) setHeight(h => Math.abs(h - e.rect!.height) < 0.5 ? h : e.rect!.height) }) : undefined, [renderer, host])
  return <div ref={setHost} testId={owner === 'modal' ? 'visual-viewer-page' : 'visual-tab'} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative' }}>
    <VisualSlot id={id} height={height} active={doc.owner === owner && shown} />
    {!doc.ready && !doc.error && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      <Spinner size={12} color={t.textTertiary} /><Label color={t.textTertiary} size={12}>Rendering…</Label>
    </div>}
    {doc.error && <div testId="visual-error" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 }}>
      <Label color={t.text} weight={500} style={{ textAlign: 'center' }}>Couldn’t show this visual</Label>
      <Label color={t.textSecondary} size={13} style={{ textAlign: 'center', lineClamp: 2 }}>{doc.error}</Label>
      <Button testId="visual-retry" icon={T.rotateCcw} onClick={() => reloadDoc(id)}>Reload</Button>
    </div>}
  </div>
}
