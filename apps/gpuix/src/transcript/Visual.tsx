import { memo, useEffect, useRef, useState } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import type { HtmlVisual } from '../../../../packages/kybern-client/src/types.ts'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import { visualFrameHeight, visualHeight, visualLink, visualThemeFragment, VISUAL_COLUMN_WIDTH } from '../../../../packages/kybern-client/src/visuals.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { Button } from './kit.tsx'
import { webHost } from '../native/webview.ts'
import { observeElementBounds, type ElementBoundsEvent } from '../native/layout.ts'
import { useNativeWindowSize } from '../native/layout-hooks.ts'
import { useWebLayer } from '../native/web-occlusion.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { visualTheme } from '../preview/theme.ts'
import { launchBrowser } from '../preview/browser.ts'
import { useNav } from '../nav/store.ts'

const heights = new Map<string, number>()
const placements = new Map<string, () => void>()

/** Geometry leases keep the same WK document while expanding/collapsing. */
function VisualSlot({ id, height, active }: { id: string; height: number; active: boolean }) {
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
  return <div ref={ref} testId="visual-frame" style={{ height, width: '100%', flexShrink: 0 }} />
}

export const VisualCard = memo(function VisualCard({ visual, threadId }: { visual: HtmlVisual; threadId: string }) {
  const t = useTheme(), size = useNativeWindowSize(), id = `visual:${threadId}:${visual.id}`
  const [error, setError] = useState(''), [attempt, retry] = useState(0), [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false), [skeleton, setSkeleton] = useState(false)
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
  const frame = <VisualSlot id={id} height={expanded ? Math.max(100, size.height - 150) : height} active={active && loaded && !error} />
  return <div testId="visual-card" style={{ display: 'flex', flexDirection: 'column', marginTop: 8, marginBottom: 8, position: 'relative' }}>
    {expanded ? <><div style={{ height, width: '100%' }} /><Dialog width={Math.max(320, size.width - 64)} onClose={() => setExpanded(false)} testId="visual-expanded"><DialogHeader title={visual.title || 'Interactive visual'} onClose={() => setExpanded(false)} />{frame}</Dialog></> : frame}
    {skeleton && !loaded && !error && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height, backgroundColor: t.surface, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Label color={t.textTertiary} size={12}>{`Loading ${visual.title}…`}</Label></div>}
    {error ? <div style={{ display: 'flex', padding: 12, gap: 8 }}><Label color={t.textSecondary} size={12}>{`Couldn’t load “${visual.title}”: ${error}`}</Label><Button onClick={() => retry(n => n + 1)}>Retry</Button></div> : loaded && <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Button testId="visual-expand" variant="ghost" onClick={() => setExpanded(true)}>Expand preview</Button></div>}
  </div>
})
