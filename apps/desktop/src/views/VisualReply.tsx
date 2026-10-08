import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/kit/button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { PanelExpandIcon, RotateCcwIcon } from "@/lib/kit/icons"
import { observeLoopVisibility } from "@/lib/loopVisibility"
import { observeResizeFrame } from "@/lib/resizeObserver"
import { openExternal } from "@/lib/tauri"
import type { HtmlVisual, ThreadId } from "@/protocol"
import { activeRuntime, errorText } from "@/state/rpc"
import { useStore } from "@/state/store"
import { currentTheme, setPreviewOrigin } from "./visualFrameSupport"
import { visualFrameHeight, visualHeight, visualLink, visualThemeFragment, VISUAL_COLUMN_WIDTH } from "../../../../packages/kybern-client/src/visuals"

// Last settled height per visual and mode, so a remount (virtual rows, thread revisit) reserves
// the exact box. In memory only; bounded.
const HEIGHT_CACHE_LIMIT = 256
const heightCache = new Map<string, { width: number; height: number }>()
function rememberHeight(key: string, width: number, height: number) {
  heightCache.delete(key); heightCache.set(key, { width, height })
  if (heightCache.size > HEIGHT_CACHE_LIMIT) heightCache.delete(heightCache.keys().next().value!)
}
function recalledHeight(key: string, width: number): number | undefined {
  const entry = heightCache.get(key)
  return entry && Math.abs(entry.width - width) <= 1 ? entry.height : undefined
}

const SKELETON_DELAY_MS = 200
const LOAD_WATCHDOG_MS = 4000
const PANEL_MAX_HEIGHT = 20_000
type Status = "minting" | "loading" | "ready" | "error"

/**
 * One sandboxed document. Its URL and DOM stay stable across turn updates; posted sizes go
 * straight to the box height (no React render per message). "inline" sits directly on the
 * thread surface; "panel" fills the dock Preview tab, where the dock scroller scrolls it.
 */
export const VisualFrame = memo(function VisualFrame({ threadId, visual, mode = "inline", active = true }: { threadId: ThreadId; visual: HtmlVisual; mode?: "inline" | "panel"; active?: boolean }) {
  const panel = mode === "panel"
  const boxRef = useRef<HTMLDivElement>(null), frameRef = useRef<HTMLIFrameElement>(null)
  const [url, setUrl] = useState<string | null>(null), [error, setError] = useState("")
  const [status, setStatus] = useState<Status>("minting")
  const [attempt, setAttempt] = useState(0)
  const [skeleton, setSkeleton] = useState(false)
  const [width, setWidth] = useState(VISUAL_COLUMN_WIDTH)
  const post = useRef<() => void>(() => {})
  const statusRef = useRef<Status>("minting"), sized = useRef(false), stopResize = useRef<() => void>(() => {})
  // The height last written to the box. Re-renders reuse it, so React never overwrites a posted
  // height with one computed from a width that stopped updating once the page reported its size.
  const applied = useRef<number | null>(null)
  // Survives `active` toggles, which re-run the message effect between a ready signal and its timer.
  const readyTimer = useRef(0), watchdog = useRef(0)
  const cacheKey = `${visual.id}:${mode}`
  const measured = !!visual.heights?.length
  const settle = useCallback((next: Status) => { statusRef.current = next; setStatus(next) }, [])

  // Measure before the first paint so a measured page reserves its final box.
  useLayoutEffect(() => {
    const box = boxRef.current
    const measuredWidth = box ? Math.round(box.clientWidth) : 0
    if (measuredWidth > 0 && Math.abs(measuredWidth - width) >= 1) setWidth(measuredWidth)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Follow the column only until the page reports a height; after that its own size posts drive layout.
  useEffect(() => {
    const box = boxRef.current
    if (!box || sized.current) return
    stopResize.current = observeResizeFrame(box, entries => {
      if (sized.current) return
      const next = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0)
      if (next > 0) setWidth(current => Math.abs(current - next) >= 1 ? next : current)
    })
    return () => stopResize.current()
  }, [attempt])

  useEffect(() => {
    setUrl(null); setError(""); settle("minting"); setSkeleton(false); sized.current = false
    window.clearTimeout(readyTimer.current); window.clearTimeout(watchdog.current); readyTimer.current = 0
    const runtime = activeRuntime(); let alive = true; let ticket: string | null = null
    const timer = window.setTimeout(() => { if (alive && statusRef.current !== "ready") setSkeleton(true) }, SKELETON_DELAY_MS)
    void runtime.visualFrameUrl(threadId, visual.id).then(frame => {
      ticket = frame.ticket
      if (alive) { setUrl(frame.url + visualThemeFragment(currentTheme())); settle("loading") }
      else void runtime.rpc().call("threads.visuals.revoke", { thread_id: threadId, ticket }).catch(() => {})
    }).catch(failure => { if (alive) { setError(errorText(failure)); settle("error") } })
    return () => { alive = false; window.clearTimeout(timer); if (ticket) void runtime.rpc().call("threads.visuals.revoke", { thread_id: threadId, ticket }).catch(() => {}) }
  }, [threadId, visual.id, attempt, settle])

  // A consumed or expired ticket serves a plain 404 body that stays invisible; turn it into Retry.
  useEffect(() => () => { window.clearTimeout(watchdog.current); window.clearTimeout(readyTimer.current) }, [])
  const armWatchdog = () => {
    window.clearTimeout(watchdog.current)
    watchdog.current = window.setTimeout(() => { if (statusRef.current === "loading") { setError(""); settle("error") } }, LOAD_WATCHDOG_MS)
  }

  useEffect(() => {
    if (status === "ready" || status === "error" || !skeleton) return
    const box = boxRef.current
    return box ? observeLoopVisibility(box) : undefined
  }, [status, skeleton])

  useEffect(() => {
    const element = frameRef.current, box = boxRef.current; if (!element || !box || !url) return
    let intersects = false, frame = 0, pendingHeight: number | null = null, lastVisible: boolean | undefined
    const ancestors: HTMLElement[] = []; let ancestor: HTMLElement | null = element.parentElement
    while (ancestor) { ancestors.push(ancestor); ancestor = ancestor.parentElement }
    const send = () => {
      const visible = active && intersects && !document.hidden && !ancestors.some(parent => getComputedStyle(parent).opacity === "0")
      lastVisible = visible
      const theme = currentTheme()
      element.contentWindow?.postMessage({ kind: "kybern-visual-host", theme, visible }, "*")
      // The page flips its own scheme first; the frame's follows next frame so no opaque canvas shows between.
      if (statusRef.current === "ready") requestAnimationFrame(() => { element.style.colorScheme = theme.appearance })
    }
    post.current = send
    const observer = new IntersectionObserver(entries => { intersects = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0); send() })
    observer.observe(element)
    const mutations = new MutationObserver(send)
    // The box is skipped: its style changes with every posted height, which is not a theme change.
    for (const parent of ancestors) if (parent !== box) mutations.observe(parent, { attributes: true, attributeFilter: ["class", "style", "data-theme-variant"] })
    const apply = () => {
      frame = 0; if (pendingHeight === null) return
      const next = panel ? Math.max(80, Math.min(PANEL_MAX_HEIGHT, pendingHeight)) : visualFrameHeight(visual, Math.round(box.clientWidth) || VISUAL_COLUMN_WIDTH, pendingHeight)
      box.style.height = `${next}px`; applied.current = next
      rememberHeight(cacheKey, Math.round(box.clientWidth), next)
      if (!sized.current) { sized.current = true; stopResize.current() }
      if (statusRef.current !== "ready") { window.clearTimeout(readyTimer.current); settle("ready") }
    }
    const message = (event: MessageEvent) => {
      if (event.source !== element.contentWindow || event.origin !== "null" || !event.data || typeof event.data !== "object") return
      if (event.data.kind === "kybern-visual-size") {
        const height = visualHeight(event.data.height, panel ? PANEL_MAX_HEIGHT : undefined)
        if (height === null) return
        pendingHeight = height
        if (!frame) frame = requestAnimationFrame(apply)
      } else if (event.data.kind === "kybern-visual-ready") {
        // Reveal on the first size post (one frame later), so a measurement that differs from this
        // engine's layout by a few pixels settles while the page is still invisible. The timer only
        // covers a page that never posts a size; a measured page has its box already.
        if (statusRef.current === "loading" && !readyTimer.current) readyTimer.current = window.setTimeout(() => { if (statusRef.current === "loading") settle("ready") }, measured ? 100 : 250)
      } else if (event.data.kind === "kybern-visual-link" && lastVisible && navigator.userActivation?.isActive) {
        const link = visualLink(event.data.url); if (link) void openExternal(link).catch(failure => { setError(errorText(failure)) })
      }
    }
    window.addEventListener("message", message); document.addEventListener("visibilitychange", send); send()
    return () => { observer.disconnect(); mutations.disconnect(); window.removeEventListener("message", message); document.removeEventListener("visibilitychange", send); cancelAnimationFrame(frame); post.current = () => {}; element.contentWindow?.postMessage({ kind: "kybern-visual-host", visible: false }, "*") }
  }, [url, active, panel, visual, measured, cacheKey, settle])

  // Hand the canvas its real scheme once the page is painted (see the no-flash note in the spec).
  useLayoutEffect(() => {
    if (status === "ready" && frameRef.current) frameRef.current.style.colorScheme = currentTheme().appearance
  }, [status])

  const retry = () => { setAttempt(value => value + 1); requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true })) }
  const reserved = applied.current ?? (panel
    ? recalledHeight(cacheKey, width) ?? visualFrameHeight({ ...visual, height: Math.max(visual.height, 80) }, width)
    : visualFrameHeight(visual, width, recalledHeight(cacheKey, width)))
  const ready = status === "ready"
  const open = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    setPreviewOrigin(event.currentTarget)
    useStore.getState().openVisualPreview(threadId, visual)
  }, [threadId, visual])
  const content = <>
    {url && <iframe ref={frameRef} title={visual.title} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => { post.current(); armWatchdog() }} className="visual-reply__frame" data-ready={ready} data-visual-frame={visual.id} style={ready ? { opacity: 1 } : { opacity: 0, colorScheme: "light" }} />}
    {skeleton && !ready && status !== "error" && <div className="visual-reply__skeleton" role="status" aria-label={`Loading ${visual.title}`} />}
    {status === "error" && <div className="visual-reply__error" aria-live="polite">
      <p className="text-[length:var(--app-font-size-ui,12px)] font-medium text-[var(--color-text-foreground)]">Couldn’t load “{visual.title}”</p>
      {error && <p className="line-clamp-2 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground-secondary)]">{error}</p>}
      <Button variant="subtle" size="xs" onClick={retry}><RotateCcwIcon className="size-3.5" />Retry</Button>
    </div>}
    {!panel && ready && <Tooltip>
      <TooltipTrigger render={<Button variant="glass" size="icon-sm" aria-label="Open in panel" className="visual-reply__open" onClick={open} />}>
        <PanelExpandIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom" align="end">Open in panel</TooltipPopup>
    </Tooltip>}
  </>
  if (panel) return <div className="visual-reply-panel px-4 py-3" data-status={status}>
    <div ref={boxRef} tabIndex={-1} className="visual-reply-panel__box relative w-full outline-none" style={{ height: reserved }}>
      {content}
    </div>
  </div>
  return <div ref={boxRef} role="figure" aria-label={visual.title} tabIndex={-1} className="visual-reply chat-paint-host outline-none" data-visual-reply={visual.id} data-status={status} style={{ height: reserved }}>
    {content}
  </div>
})

/** A visual published into the transcript. */
export const VisualReply = memo(function VisualReply({ threadId, visual }: { threadId: ThreadId; visual: HtmlVisual }) {
  return <VisualFrame threadId={threadId} visual={visual} />
})
