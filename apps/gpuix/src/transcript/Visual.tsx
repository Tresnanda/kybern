// An agent's inline HTML visual (ADE-69, A′): a borderless figure on the thread with a caption line under it.
//
// At rest the figure is a picture the daemon drew (`visualPicture.ts`): a GPUI image, so it scrolls, clips and fades
// under the glass composer like any row and costs no web process. A click makes it live in place: the visual's WK
// document (`visualDocs.ts`) is placed over the picture's exact rect, the click is replayed on the control it landed
// on, and a hairline ring marks it. Esc, Done, a press anywhere else, scrolling it half out of view or sliding it
// under the composer freeze the document (`snapshot`) into the picture again, pixel for pixel, and hide it warm.
// "Open in a tab" and "Full screen" (a window-sized dialog, ADE-80) hand the same document over, so its state survives.
// Tall pages rest clamped at 480 with a fade baked into the picture's alpha (glass shows through) and "Show more". A
// visual that asks (`await_answer`) draws the answer bar under it instead of the caption (`VisualAnswer.tsx`); the bar
// and its receipt carry the same Show more and Full screen tools, so a tall question never has to be read in a slot.
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { readFile } from 'node:fs/promises'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { ChartHistogramIcon, FullScreenIcon, RefreshIcon, SquareArrowExpand01Icon, ChevronUpIcon } from '@hugeicons/core-free-icons'
import type { HtmlVisual, JsonValue, VisualAnswerRecord } from '../../../../packages/kybern-client/src/types.ts'
import { visualFrameHeight, VISUAL_COLUMN_WIDTH, type VisualTheme } from '../../../../packages/kybern-client/src/visuals.ts'
import { usePaneAccess, useApp, getClient } from '../state.ts'
import { openTabFromPane } from '../tabs/open.ts'
import { useChatHidden } from '../tabs/hidden.ts'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { Kbd } from '../kit/Kbd.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { useControls } from '../kit/controls.ts'
import { glyph, Icon, ICONS } from '../icons.tsx'
import { T } from './glyphs.ts'
import { Dialog, Menu, MenuItem, MenuSeparator, Tip, useDialogClose } from '../nav/overlay.tsx'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { webHost } from '../native/webview.ts'
import { observeElementBounds, type ElementBoundsEvent, type LayoutRect } from '../native/layout.ts'
import { useNativeWindowSize } from '../native/layout-hooks.ts'
import { useWebLayer } from '../native/web-occlusion.ts'
import { visualTheme } from '../preview/theme.ts'
import { useNav } from '../nav/store.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { DURATION, EASE, HOVER_FADE, webDocumentEnter } from '../motion/kit.tsx'
import { copyImage, saveImageFile } from '../platform/files.ts'
import { toast } from '../shell/toasts.tsx'
import { copyText } from './store.ts'
import { composerCardRects } from '../composer/height.ts'
import { focusThreadComposer } from '../composer/focus.ts'
import { imageCachePath } from './imageFiles.ts'
import { usePicture, type Picture } from './visualPicture.ts'
import { claimDoc, docId, docState, freezeDoc, listenDoc, releaseDoc, reloadDoc, subscribeDocs, themeDoc, type DocOwner } from './visualDocs.ts'
import { useTranscriptRowLease } from './Window.tsx'
import { AnswerBar, AnswerReceipt, registerAnswerReveal, setAnswerOnScreen, useVisualAnswer, type VisualAsk } from '../requests/VisualAnswer.tsx'
import { FONT_MONO } from '../theme.ts'
import { OpenInBrowserButton, VisualStill } from './VisualStill.tsx'
import { visualMode } from './visualFallback.ts'
import { isPrimary } from '../platform/keys.ts'

/** With no embedded web view a visual stays a picture: no live page, no tab, and its controls open in the browser (`visualFallback.ts`). */
const LIVE = visualMode(webHost.available) === 'live'
const CHART = glyph(ChartHistogramIcon)
const RELOAD = glyph(RefreshIcon)
const FULL_SCREEN = glyph(FullScreenIcon)
/** The image viewer's Open in tab glyph, so it is not mistaken for Full screen. */
const OPEN_TAB = glyph(SquareArrowExpand01Icon)
/** The caption's Show more chevron, and its reverse. */
const SHOW_MORE = T.chevronDown, SHOW_LESS = glyph(ChevronUpIcon)
/** Tall pages rest this tall (the daemon cuts the faded picture at the same height). */
export const VISUAL_CLAMP = 480
const MAX_HEIGHT = 2000
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

const placements = new Map<string, () => void>()

/** Places the visual's document over this box while `active`. Only the slot that placed it hides it again, so the
 * inline figure and the tab can hand one document between them without either hiding the other's placement. */
export function VisualSlot({ id, height, active, radius = 0 }: { id: string; height: number; active: boolean; radius?: number }) {
  const renderer = useGpuixRequired(), ref = useRef<PublicInstance | null>(null), layer = useWebLayer()
  useEffect(() => {
    if (!ref.current || !active) return
    let latest: ElementBoundsEvent | undefined
    const place = () => {
      const rect = latest?.rect, clip = latest?.clippedRect
      if (!rect || !clip) { webHost.hide(id); return }
      webHost.place(id, rect, clip, { width: rect.width, height: rect.height, scale: 1, left: 0, top: 0, radius, roundedClips: latest?.roundedClips }, true, layer)
    }
    placements.set(id, place)
    const stop = observeElementBounds(renderer, ref.current.id, bounds => { latest = bounds; place() })
    // The native host is created once the frame ticket arrives, often after the box was first placed (a place for a
    // host that does not exist yet is dropped): place it again when it exists, or the page stays blank and unclickable.
    const unsubscribe = webHost.subscribe(event => { if (event.id === id && (event.type === 'created' || event.type === 'loaded') && placements.get(id) === place) place() })
    return () => { stop(); unsubscribe(); if (placements.get(id) === place) { placements.delete(id); webHost.hide(id) } }
  }, [renderer, id, layer, active, radius])
  return <div ref={ref} testId="visual-frame" style={{ height, width: '100%', flexShrink: 0 }} />
}

/** The document's owner and readiness, as one stable value per change. */
function useDoc(id: string) {
  const raw = useSyncExternalStore(subscribeDocs, () => { const d = docState(id); return d ? `${d.owner ?? ''}|${d.ready ? 1 : 0}|${d.error}` : '' })
  if (!raw) return { owner: null, ready: false, error: '' }
  const [owner, ready, ...error] = raw.split('|')
  return { owner: (owner || null) as 'inline' | 'tab' | null, ready: ready === '1', error: error.join('|') }
}

type Hit = { x: number; y: number; w: number; h: number; r: number }
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
  const [expanded, setExpanded] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const [hover, setHover] = useState(false), [focus, setFocus] = useState(false), [menuOpen, setMenuOpen] = useState(false)
  const [hit, setHit] = useState<Hit | null>(null)
  const [liveHeight, setLiveHeight] = useState<number | null>(null)
  /** The picture under a live document is hidden once the document has faded in (the page is transparent). */
  const [covered, setCovered] = useState(false)
  const [returning, setReturning] = useState(false)
  const [starting, setStarting] = useState(false)
  const pendingClick = useRef<{ x: number; y: number } | null>(null)
  const cardRect = useRef<LayoutRect | null>(null)
  const figure = useRef<PublicInstance | null>(null), card = useRef<PublicInstance | null>(null)
  const freezeToken = useRef(0)
  const hidden = useChatHidden()
  const shown = useNav(state => state.page === 'home' && !state.settingsOpen) && !hidden

  const inline = doc.owner === 'inline'
  const live = inline && doc.ready
  const inTab = doc.owner === 'tab'
  // The picture's height at this width; before it loads, the daemon's measured height (no jump when it arrives).
  const scale = picture && width ? width / picture.width : 1
  const natural = Math.min(MAX_HEIGHT, picture ? Math.round(picture.height * scale) : visualFrameHeight(visual, width ?? VISUAL_COLUMN_WIDTH))
  const tall = natural > VISUAL_CLAMP
  const clamped = tall && !expanded
  const height = live && liveHeight && !tall ? Math.min(MAX_HEIGHT, liveHeight) : clamped ? VISUAL_CLAMP : natural
  const failed = !picture && !!pictureError
  const loading = !picture && !pictureError
  const narrow = (width ?? VISUAL_COLUMN_WIDTH) < NARROW

  // Theme changes reach a live or warm document at once.
  useEffect(() => { themeDoc(id, theme) }, [id, theme])
  // A new picture (theme, width or the answered look) replaces a frozen frame.
  useEffect(() => { if (!live && !returning) setFrozen(null) }, [picture?.path])

  const reveal = () => {
    webDocumentEnter(id, webHost.present)
    setStarting(false)
    setTimeout(() => setCovered(true), DURATION.quick * 1000)
    const click = pendingClick.current
    pendingClick.current = null
    if (click) setTimeout(() => webHost.send(id, { kind: 'kybern-visual-click', x: click.x, y: click.y }), 30)
    if (lock) webHost.send(id, { kind: 'kybern-visual-lock', ...lock })
  }
  const activate = (click: { x: number; y: number } | null) => {
    if (!LIVE) return
    if (inTab) { openTabFromPane(pane.id, { kind: 'visual', id: visual.id, title: visual.title || 'Interactive visual' }); return }
    if (inline) { if (click && live) webHost.send(id, { kind: 'kybern-visual-click', x: click.x, y: click.y }); return }
    ask.interacted()
    pendingClick.current = click
    const wasReady = docState(id)?.ready
    claimDoc(threadId, visual.id, 'inline', theme)
    if (wasReady) reveal(); else setTimeout(() => { if (docState(id)?.owner === 'inline' && !docState(id)?.ready) setStarting(true) }, 200)
  }
  /** Freeze the live document into the picture, then hide it warm. */
  const deactivate = () => {
    if (!inline || returning) return
    if (!live) { releaseDoc(id, 'inline'); setStarting(false); setCovered(false); return }
    setReturning(true)
    const token = freezeToken.current = freezeDoc(id, imageCachePath(`visual-frame-${process.pid}-${++frames}.png`))
    // A frame that does not arrive in time: show the daemon picture instead.
    setTimeout(() => { if (freezeToken.current === token) finishReturn() }, 600)
  }
  // Handlers registered once (the key handler, the bounds observer) call the current one.
  const exit = useRef(deactivate); exit.current = deactivate
  const finishReturn = () => {
    freezeToken.current = 0
    setCovered(false)
    releaseDoc(id, 'inline')
    setReturning(false)
    setLiveHeight(null)
    webHost.releaseFocus()
    focusThreadComposer(pane.id)
  }

  useEffect(() => listenDoc(id, message => {
    switch (message.kind) {
      case 'ready': if (docState(id)?.owner === 'inline') { if (message.height) setLiveHeight(message.height); reveal() } return
      case 'size': setLiveHeight(message.height); return
      case 'escape': deactivate(); return
      case 'retire': deactivate(); return
      case 'outsidePress': {
        const r = cardRect.current
        if (!r || message.x < r.x || message.x > r.x + r.width || message.y < r.y || message.y > r.y + r.height) deactivate()
        return
      }
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
      case 'error': setStarting(false); return
    }
  }))

  // Esc while GPUI holds the keyboard (after a press on the caption): back to the picture.
  useEffect(() => inline ? addWindowKeyHandler(e => { if (e.key === 'escape' && !isPrimary(e.modifiers)) { exit.current(); return true } }) : undefined, [inline])
  // Leaving the chat (a tab, Settings, another page) freezes it too; a tab that takes the document is not leaving.
  useEffect(() => { if (!shown && inline) deactivate() }, [shown, inline])
  // The figure's box: its width picks the picture; half out of view or under the composer, a live document freezes.
  useEffect(() => {
    if (!figure.current) return
    return observeElementBounds(renderer, figure.current.id, e => {
      if (e.rect) setBox(b => b && Math.abs(b.width - e.rect!.width) < 1 && Math.abs(b.x - e.rect!.x) < 1 && Math.abs(b.y - e.rect!.y) < 1 ? b : e.rect)
      const visible = e.rect && e.clippedRect ? e.clippedRect.height / Math.max(1, e.rect.height) : 0
      setAnswerOnScreen(visual.id, visible > 0.25)
      if (docState(id)?.owner !== 'inline' || !e.rect) return
      const under = composerCardRects().some(r => e.rect!.y + e.rect!.height > r.y + 2 && e.rect!.y < r.y + r.height && e.rect!.x < r.x + r.width && e.rect!.x + e.rect!.width > r.x)
      if (visible < 0.5 || under) exit.current()
    })
  }, [renderer, id])
  useEffect(() => card.current ? observeElementBounds(renderer, card.current.id, e => { cardRect.current = e.rect }) : undefined, [renderer])
  useEffect(() => registerAnswerReveal(visual.id, () => { if (figure.current) (renderer as { scrollIntoView?: (id: number) => void }).scrollIntoView?.(figure.current.id) }), [renderer, visual.id])
  // Sending freezes the page to a picture (and closes the full-screen viewer); the answer, once recorded, reaches a live
  // page as its locked look.
  useEffect(() => { if (ask.state !== 'sending') return; if (inline) deactivate(); setFullScreen(false) }, [ask.state, inline])
  useEffect(() => { if (lock && docState(id)?.ready) webHost.send(id, { kind: 'kybern-visual-lock', ...lock }) }, [answer?.status])
  useEffect(() => () => { setAnswerOnScreen(visual.id, false); if (docState(id)?.owner === 'inline') releaseDoc(id, 'inline') }, [id])

  // The control under the pointer, in page pixels.
  const pageAt = (e: { x?: number; y?: number }) => box && e.x != null && e.y != null ? { x: (e.x - box.x) / scale, y: (e.y - box.y) / scale } : null
  const controlAt = (point: { x: number; y: number } | null, controls: Picture['controls']) =>
    point ? [...controls].reverse().find(k => point.x >= k.x && point.x <= k.x + k.w && point.y >= k.y && point.y <= k.y + k.h) ?? null : null
  const source = frozen?.path ?? (picture ? (clamped && picture.fade ? picture.fade : picture.path) : null)
  const actionsShown = hover || focus || menuOpen || inline

  /** The live document is about to move: freeze it into the figure's picture first (the snapshot routes here). */
  const handOff = () => {
    if (!live) return
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
  const pictureBytes = async () => { if (!picture) throw Error('The picture is not ready yet.'); return new Uint8Array(await readFile(frozen?.path ?? picture.path)) }
  const copyPicture = () => void pictureBytes().then(bytes => { copyImage(renderer, bytes); toast.success('Image copied') }).catch(() => toast.error('Unable to copy image', { description: 'Use Save image instead, or reload the visual.' }))
  const savePicture = () => void pictureBytes().then(bytes => saveImageFile(renderer, bytes, `${visual.title || 'Visual'}.png`)).catch(() => toast.error('Unable to save image', { description: 'Reload the visual, then try again.' }))
  const copySource = () => void getClient()?.call('threads.visuals.read', { thread_id: threadId, visual_id: visual.id }).then(r => { copyText(r.html); toast.success('HTML source copied') }).catch(() => toast.error('Unable to copy the source', { description: 'Check the connection and try again.' }))
  const reload = () => { setFrozen(null); retryPicture(); if (inline) { setCovered(false); reloadDoc(id) } }

  const ring = live && !returning
  const answerBar = ask.waiting || ask.late
  const toolFocus = { onFocus: () => setFocus(true), onBlur: () => setFocus(false) }
  /** Show more and Full screen beside the answer bar and its receipt, which replace the caption that has them. */
  const tools = failed || loading ? null : <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
    {tall && <Tip label={expanded ? 'Show less' : 'Show more'} side="top" size={24}><IconButton testId="visual-more-height" size="sm" icon={expanded ? SHOW_LESS : SHOW_MORE} label={expanded ? 'Show less' : 'Show more'} onClick={() => setExpanded(v => !v)} {...toolFocus} /></Tip>}
    {!inTab && <Tip label="Full screen" shortcut={['⇧', '⌘', '↵']} side="top" size={24}><IconButton testId="visual-full-screen" size="sm" icon={FULL_SCREEN} label="Full screen" onClick={openFullScreen} {...toolFocus} /></Tip>}
  </div>
  return <div ref={card} testId="visual-card" data-status={failed ? 'error' : picture ? 'ready' : 'loading'} data-mode={live ? 'live' : inTab ? 'tab' : 'rest'}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setHit(null) }}
    style={{ display: 'flex', flexDirection: 'column', marginTop: 14, marginBottom: 12, position: 'relative' }}>
    {ring && <div testId="visual-ring-live" style={{ position: 'absolute', width: 0, height: 0 }} />}
    {/* The live ring sits 8 outside the content, where the native document never covers it: a 1 px accent line and a
        3 px halo, drawn as borders (a GPUI shadow would fill the transparent box under the page). */}
    <div paintTransform={fade(ring, ring ? DURATION.quick : HOVER_FADE.duration)} style={{ position: 'absolute', left: -11, top: -11, right: -11, height: height + 22, borderRadius: 15, pointerEvents: 'none', ...still(ring),
      borderWidth: 3, borderColor: c.acc(t.variant === 'light' ? 0.08 : 0.1) }}>
      <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 12, borderWidth: 1, borderColor: c.acc(t.variant === 'light' ? 0.45 : 0.55) }} />
    </div>
    <div ref={figure} testId="visual-figure" role={LIVE ? 'button' : 'img'} tabIndex={LIVE ? 0 : -1} aria-label={visual.title || 'Interactive visual'}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      onKeyDown={e => { if (e.key === 'enter' && isPrimary(e.modifiers) && e.modifiers?.shift) openFullScreen(); else if (e.key === 'enter' && isPrimary(e.modifiers)) openTab(); else if (e.key === 'enter' || e.key === 'space') activate(null) }}
      onMouseMove={LIVE && picture && !inline ? e => setHit(controlAt(pageAt(e), picture.controls)) : undefined}
      onClick={failed || !LIVE ? undefined : e => { const point = pageAt(e); activate(picture && controlAt(point, picture.controls) ? point : null) }}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', height, overflow: 'hidden', cursor: failed || !LIVE ? 'default' : 'pointer', opacity: inTab ? 0.38 : 1,
        focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 4 }, borderRadius: 4 }}>
      {source && <div paintTransform={fade(!covered, HOVER_FADE.duration)} style={{ position: 'absolute', left: 0, top: 0, right: 0, height: frozen ? frozen.height : clamped ? VISUAL_CLAMP : natural, pointerEvents: 'none', ...still(!covered) }}>
        <img testId="visual-picture" src={source} alt="" objectFit="fill" onLoad={returning && frozen ? finishReturn : undefined} style={{ width: '100%', height: '100%', pointerEvents: 'none' }} />
      </div>}
      {/* The hit map: the page control under the pointer gets a wash at its own box, so the click visibly reaches it. */}
      {hit && !inline && <div testId="visual-hit" style={{ position: 'absolute', left: hit.x * scale, top: hit.y * scale, width: hit.w * scale, height: hit.h * scale, borderRadius: hit.r * scale, backgroundColor: ink(t, t.variant === 'light' ? 0.06 : 0.07), pointerEvents: 'none' }} />}
      {loading && <div testId="visual-skeleton" role="status" aria-label="Rendering visual" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 10, backgroundColor: ink(t, t.variant === 'light' ? 0.035 : 0.04) }} />}
      {failed && <FigureError title={visual.title} reason={pictureError} onReload={reload} />}
      <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height }}><VisualSlot id={id} height={height} active={inline && shown} /></div>
    </div>
    {answerBar ? <AnswerBar ask={ask} live={live} tools={tools} onReply={() => focusThreadComposer(pane.id)} /> : answer && visual.ask ? <AnswerReceipt record={answer} ask={ask} title={visual.title} tools={tools &&
      <div paintTransform={fade(actionsShown)} style={{ display: 'flex', flexShrink: 0, pointerEvents: actionsShown ? 'auto' : 'none', ...still(actionsShown) }}>{tools}</div>} /> : (
      <div testId="visual-caption" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 24, marginTop: ring ? 14 : 8, minWidth: 0 }}>
        {inline ? <>
          {starting || !live ? <Spinner size={12} color={t.textTertiary} /> : <div testId="visual-live" style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accentFg, flexShrink: 0 }} />}
          <Label color={c.accentFg} size={12} lineHeight={16} weight={600} style={{ flexShrink: 0 }}>{live ? 'Live' : 'Starting…'}</Label>
          <Label color={t.textSecondary} size={12} lineHeight={16} weight={500} truncate style={{ flexShrink: 1, minWidth: 0 }}>{visual.title}</Label>
        </> : <>
          <Icon source={CHART} size={14} color={t.textTertiary} />
          <Label color={t.textSecondary} size={12} lineHeight={16} weight={500} truncate style={{ flexShrink: 1, minWidth: 0 }}>{visual.title}</Label>
          {LIVE && !narrow && !failed && !inTab && <div paintTransform={fade(hover && !loading)} style={{ display: 'flex', flexShrink: 0, ...still(hover && !loading) }}><Label color={t.textTertiary} size={12} lineHeight={16}>· Click to interact</Label></div>}
        </>}
        <div style={{ flexGrow: 1 }} />
        {!LIVE && !loading && !failed && <OpenInBrowserButton threadId={threadId} visualId={visual.id} />}
        {loading && <><Spinner size={12} color={t.textTertiary} /><Label color={t.textTertiary} size={12} lineHeight={16}>Rendering…</Label></>}
        {failed && <Label color={t.red} size={12} lineHeight={16}>Didn’t load</Label>}
        {inTab && <>
          <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accentFg }} />
          <Label color={t.textSecondary} size={12} lineHeight={16}>Live in a tab</Label>
          <Button size="sm" variant="secondary" testId="visual-show-tab" onClick={openTab}>Show tab</Button>
        </>}
        {inline && <>
          <Button size="sm" variant="ghost" testId="visual-done" onClick={deactivate} trailing={<Kbd keys={['esc']} />}>Done</Button>
          <div style={{ width: 1, height: 14, backgroundColor: t.border, flexShrink: 0 }} />
        </>}
        {!loading && !inTab && <div paintTransform={fade(actionsShown || failed)} style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, pointerEvents: actionsShown || failed ? 'auto' : 'none', ...still(actionsShown || failed) }}>
          {!failed && <Tip label="Full screen" shortcut={['⇧', '⌘', '↵']} side="top" size={24}><IconButton testId="visual-full-screen" size="sm" icon={FULL_SCREEN} label="Full screen" onClick={openFullScreen} {...toolFocus} /></Tip>}
          {LIVE && !failed && <Tip label="Open in a tab" shortcut={['⌘', '↵']} side="top" size={24}><IconButton testId="visual-expand" size="sm" icon={OPEN_TAB} label="Open in a tab" onClick={openTab} {...toolFocus} /></Tip>}
          {!narrow && !inline && !failed && <Tip label="Copy image" side="top" size={24}><IconButton testId="visual-copy" size="sm" icon={T.copy} label="Copy image" onClick={copyPicture} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} /></Tip>}
          {!narrow && !inline && <Tip label="Reload" side="top" size={24}><IconButton testId="visual-reload" size="sm" icon={RELOAD} label="Reload" onClick={reload} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} /></Tip>}
          <Menu testId="visual-more" width={200} align="end" onOpenChange={setMenuOpen} trigger={() => <IconButton size="sm" icon={ICONS.ellipsis} label="More" />}>
            {(narrow || inline) && !failed && <MenuItem id="copy" label="Copy image" onSelect={copyPicture} />}
            <MenuItem id="save" label="Save image…" disabled={!picture} onSelect={savePicture} />
            <MenuItem id="source" label="Copy HTML source" onSelect={copySource} />
            <MenuSeparator />
            <MenuItem id="reload" label="Reload" onSelect={reload} />
          </Menu>
        </div>}
        {tall && !failed && <Button size="sm" variant="ghost" testId="visual-more-height" iconAfter={expanded ? undefined : T.chevronDown} onClick={() => setExpanded(v => !v)}>{expanded ? 'Show less' : 'Show more'}</Button>}
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
