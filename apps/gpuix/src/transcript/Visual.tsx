import { useLoopRunning } from '../native/loop-visibility.ts'
import { useTranscriptRowLease } from './Window.tsx'
import { memo, useEffect, useRef, useState } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import type { HtmlVisual } from '../../../../packages/kybern-client/src/types.ts'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import { visualFrameHeight, visualHeight, visualLink, visualThemeFragment, VISUAL_COLUMN_WIDTH } from '../../../../packages/kybern-client/src/visuals.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Button } from './kit.tsx'
import { Icon } from '../icons.tsx'
import { T } from './glyphs.ts'
import { PopupLayer } from '../composer/Menu.tsx'
import { Tip } from '../nav/overlay.tsx'
import { useLoaderTime, easeInOut, NATIVE_PAINT_ANIMATIONS } from '../MatrixLoader.tsx'
import { webHost } from '../native/webview.ts'
import { observeElementBounds, type ElementBoundsEvent } from '../native/layout.ts'
import { useNativeWindowSize } from '../native/layout-hooks.ts'
import { useWebLayer } from '../native/web-occlusion.ts'
import { Dialog } from '../nav/overlay.tsx'
import { visualTheme } from '../preview/theme.ts'
import { launchBrowser } from '../preview/browser.ts'
import { useNav } from '../nav/store.ts'

const heights = new Map<string, number>()
const placements = new Map<string, () => void>()

/** Geometry leases keep the same WK document while expanding/collapsing. */
function VisualSlot({ id, height, active, onHover }: { id: string; height: number; active: boolean; onHover?: (over: boolean) => void }) {
  const renderer = useGpuixRequired(), ref = useRef<PublicInstance | null>(null), layer = useWebLayer()
  useEffect(() => {
    if (!ref.current) return
    let latest: ElementBoundsEvent | undefined
    const place = () => {
      const rect = latest?.rect, clip = latest?.clippedRect
      if (!rect || !clip || !active) { webHost.hide(id); return }
      webHost.place(id, rect, clip, { width: rect.width, height: rect.height, scale: 1, left: 0, top: 0 }, true, layer)
    }
    placements.set(id, place)
    const stop = observeElementBounds(renderer, ref.current.id, bounds => { latest = bounds; place() })
    return () => { stop(); if (placements.get(id) === place) { placements.delete(id); webHost.hide(id) } }
  }, [renderer, id, layer, active])
  // A real pointer over the document reaches its wrapper (`kybern-visual-hover`); GPUI sees it when nothing covers the slot.
  return <div ref={ref} testId="visual-frame" onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} style={{ height, width: '100%', flexShrink: 0 }} />
}

export const VisualCard = memo(function VisualCard({ visual, threadId }: { visual: HtmlVisual; threadId: string }) {
  const t = useTheme(), size = useNativeWindowSize(), id = `visual:${threadId}:${visual.id}`
  const [error, setError] = useState(''), [attempt, retry] = useState(0), [expanded, setExpanded] = useState(false)
  // A WK document has arbitrary interactive state. Once visited, retain its
  // owner until this transcript closes; native offscreen placement hides it
  // without reloading the document. Ordinary Markdown/code bodies stay bounded.
  useTranscriptRowLease(true)
  const [loaded, setLoaded] = useState(false), [skeleton, setSkeleton] = useState(false)
  // The pointer is over the figure (reported by its wrapper) or the control; the control hides a beat after both leave.
  const [overFigure, setOverFigure] = useState(false), [overControl, setOverControl] = useState(false), [showControl, setShowControl] = useState(false)
  useEffect(() => {
    if (overFigure || overControl) { setShowControl(true); return }
    const id = setTimeout(() => setShowControl(false), 120)
    return () => clearTimeout(id)
  }, [overFigure, overControl])
  const [height, setHeight] = useState(() => heights.get(id) ?? visualFrameHeight(visual, VISUAL_COLUMN_WIDTH))
  const ready = useRef(false), theme = useRef(visualTheme(t)); theme.current = visualTheme(t)
  const active = useNav(state => state.page === 'home' && !state.settingsOpen)
  useEffect(() => {
    const client = getClient(), owner = activeEnvironment()
    if (!client) return
    let alive = true, ticket: string | undefined, generation = 0
    let documentReady = false, watchdog: ReturnType<typeof setTimeout> | undefined, fallback: ReturnType<typeof setTimeout> | undefined
    const loading = setTimeout(() => { if (alive && !documentReady) setSkeleton(true) }, 200)
    const reveal = () => { documentReady = true; clearTimeout(watchdog); clearTimeout(fallback); clearTimeout(loading); if (alive) { setLoaded(true); setSkeleton(false); setError('') } }
    setError(''); setLoaded(false); setSkeleton(false); ready.current = false
    const stop = webHost.subscribe(event => {
      if (event.id !== id || !alive || (event.generation !== undefined && event.generation !== generation)) return
      if (event.type === 'created' || event.type === 'loaded') { ready.current = true; placements.get(id)?.(); webHost.theme(id, theme.current) }
      if (event.type === 'failed' || event.type === 'terminated') setError(event.message ?? 'The page stopped responding. Retry to reload it.')
      if (event.type !== 'message' || !event.data) return
      if (event.data.kind === 'kybern-visual-hover') { setOverFigure(!!event.data.value); return }
      if (event.data.kind === 'loaded' && !documentReady) { clearTimeout(watchdog); watchdog = setTimeout(() => { if (alive && !documentReady) setError('The preview expired or did not finish loading. Retry to reopen it.') }, 4000) }
      if (event.data.kind === 'kybern-visual-ready' && !documentReady && !fallback) fallback = setTimeout(reveal, 1000)
      if (event.data.kind === 'kybern-visual-size') {
        const measured = visualHeight(event.data.height)
        if (measured !== null) {
          const next = visualFrameHeight(visual, VISUAL_COLUMN_WIDTH, measured)
          heights.delete(id); heights.set(id, next); if (heights.size > 256) heights.delete(heights.keys().next().value!)
          setHeight(next)
          reveal()
        }
      } else if (event.data.kind === 'kybern-visual-link') {
        const link = visualLink(event.data.url)
        if (link) void launchBrowser(link).catch(error => setError(String(error)))
      }
    })
    void client.call('threads.visuals.frame', { thread_id: threadId, visual_id: visual.id }).then(result => {
      ticket = result.ticket
      if (!alive || owner !== activeEnvironment()) { void client.call('threads.visuals.revoke', { thread_id: threadId, ticket }); ticket = undefined; return }
      const url = `${httpBase(client.endpoint.url)}/visual-frame/${encodeURIComponent(ticket)}` + visualThemeFragment(theme.current)
      try { generation = webHost.create(id, url, 'visual') } catch (error) { setError(String(error)) }
    }).catch(error => { if (alive) setError(String(error)) })
    return () => { alive = false; ready.current = false; clearTimeout(loading); clearTimeout(watchdog); clearTimeout(fallback); stop(); webHost.destroy(id); if (ticket) void client.call('threads.visuals.revoke', { thread_id: threadId, ticket }).catch(() => {}) }
  }, [threadId, visual.id, id, attempt])
  useEffect(() => { if (ready.current) webHost.theme(id, theme.current) }, [id, t])
  const [expandedHeight, expandedWidth] = [Math.max(100, size.height - 32 - 44 - 2), Math.max(320, size.width - 32)]
  const frame = <VisualSlot id={id} height={expanded ? expandedHeight : height} active={active && loaded && !error} onHover={setOverFigure} />
  const control = showControl && loaded && !error && !expanded
  return <div testId="visual-card" data-status={error ? 'error' : loaded ? 'ready' : 'loading'} style={{ display: 'flex', flexDirection: 'column', marginTop: 8, marginBottom: 8, position: 'relative' }}>
    {expanded ? <>
      <div style={{ height, width: '100%' }} />
      <Dialog instant width={expandedWidth} radius={14} onClose={() => setExpanded(false)} testId="visual-expanded">
        {/* The desktop's native <dialog> opens and closes without motion (`instant`). `.visual-reply__expanded-header`: 44px, 16px / 8px inset, the title and a ghost close button. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, paddingLeft: 16, paddingRight: 8, backgroundColor: t.surface }}>
          <Label color={t.text} weight={500} truncate style={{ flexGrow: 1 }}>{visual.title || 'Interactive visual'}</Label>
          <div testId="dialog-close" role="button" aria-label="Close expanded preview" onClick={() => setExpanded(false)} style={{ display: 'flex', width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, cursor: 'pointer', flexShrink: 0, hover: { backgroundColor: t.buttonSecondaryHover } }}>
            <Icon source={T.close} size={14} color={t.textSecondary} />
          </div>
        </div>
        {frame}
      </Dialog>
    </> : <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {frame}
      {/* The glass control sits 8px inside the top-right corner (`.visual-reply__open`). It is an anchored layer so it paints above the native document. */}
      {control && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 0 }}>
        <PopupLayer kind="tooltip" side="bottom" align="end" sideOffset={8} alignOffset={-8} material="none" occlude style={{ borderRadius: 14 }}>
          <Tip label="Expand preview" side="bottom" size={28}>
            <div
              testId="visual-expand"
              role="button"
              aria-label="Expand preview"
              onClick={() => { setOverControl(false); setExpanded(true) }}
              onMouseEnter={() => setOverControl(true)}
              onMouseLeave={() => setOverControl(false)}
              style={{
                display: 'flex', width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 14, cursor: 'pointer',
                borderWidth: 1, borderColor: t.border, backgroundColor: t.v('--color-background-elevated-primary-opaque'),
                boxShadow: t.variant === 'dark'
                  ? { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.4)' }
                  : { offsetX: 0, offsetY: 2, blurRadius: 8, spreadRadius: -2, color: 'rgba(0, 0, 0, 0.1)' },
                hover: { backgroundColor: t.v('--color-background-elevated-secondary') },
              }}
            >
              <Icon source={T.expand} size={14} color={t.textSecondary} />
            </div>
          </Tip>
        </PopupLayer>
      </div>}
    </div>}
    {skeleton && !loaded && !error && <Skeleton height={height} />}
    {error && <div testId="visual-error" style={{ position: 'absolute', top: 0, left: 0, right: 0, height, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: Math.min(height * 0.35, 160), paddingLeft: 16, paddingRight: 16, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: ink(t, 0.04) }}>
      <Label color={t.text} weight={500} style={{ textAlign: 'center' }}>{`Couldn’t load “${visual.title}”`}</Label>
      {error && <Label color={t.textSecondary} size={13} style={{ textAlign: 'center', lineClamp: 2 }}>{error}</Label>}
      <Button testId="visual-retry" variant="subtle" onClick={() => retry(n => n + 1)}><Icon source={T.rotateCcw} size={14} color={t.text} />Retry</Button>
    </div>}
  </div>
})

/** `.visual-reply__skeleton`: a 4% wash over the reserved box, breathing between full and 55% opacity every 1.6s
 * (ease-in-out each way). Paint-only: each 800 ms half is one native `paintTransform` opacity tween, and its
 * completion retargets the other way, so frames run at display rate with one React commit per half cycle. */
export function Skeleton({ height }: { height: number }) {
  const t = useTheme()
  const loop = useLoopRunning(!REDUCED_MOTION)
  const native = NATIVE_PAINT_ANIMATIONS && loop.running
  const time = useLoaderTime(loop.visible && !NATIVE_PAINT_ANIMATIONS)
  const [dim, setDim] = useState(true)
  const phase = (time % 1600) / 1600
  const opacity = REDUCED_MOTION || NATIVE_PAINT_ANIMATIONS ? 1 : 1 - 0.45 * easeInOut(phase < 0.5 ? phase * 2 : 2 - phase * 2)
  return <div ref={loop.ref} testId="visual-skeleton" role="status" aria-label="Loading visual"
    {...(native ? { paintTransform: { initial: { opacity: 1 }, animate: { opacity: dim ? 0.55 : 1 }, transition: { duration: 0.8, ease: [0.42, 0, 0.58, 1] } } } : {})}
    onMotionComplete={native ? () => setDim(value => !value) : undefined}
    style={{ position: 'absolute', top: 0, left: 0, right: 0, height, borderRadius: 10, backgroundColor: ink(t, 0.04), opacity, pointerEvents: 'none' }} />
}
