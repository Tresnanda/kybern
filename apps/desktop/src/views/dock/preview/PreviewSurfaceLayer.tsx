import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { ThreadId } from "@/protocol"
import {
  bridgeNav,
  bridgeNavStart,
  endLoading,
  frameLoaded,
  installPreviewRelayListener,
  loadPreviewEntry,
  registerFrameApi,
  releasePreviewFrame,
  usePreviewSession,
} from "@/state/previewSession"
import {
  dockedSize,
  installPreviewSurfaceTriggers,
  pokePreviewLayout,
  registerSurface,
  setPreviewScale,
  syncPreviewSurfaces,
  usePreviewSurface,
  type PreviewRect,
  type PreviewSlotKind,
} from "@/state/previewSurface"
import { useStore, type PreviewViewport, type WebPreview } from "@/state/store"
import { validateBridgeMessage } from "../../../../../../packages/kybern-client/src/previewTarget"
import {
  fitAxis,
  resizeViewport,
  viewportLayout,
  type ResizeEdge,
} from "../../../../../../packages/kybern-client/src/previewViewport"

/** A docked page hidden this long unloads and reloads when shown again. */
export const PREVIEW_HIDDEN_UNLOAD_MS = 5 * 60_000
/** The loading bar ends silently after this long. */
const LOADING_CEILING_MS = 15_000

/** Sandbox strings are fixed by the preview security model. Never add top-navigation or popups. */
export const FILE_SANDBOX = "allow-scripts allow-forms allow-modals"
export const SERVER_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"

/**
 * The one place live page documents exist. At most two are mounted: the selected thread's docked
 * page and the floating page. Keyed by thread so a page keeps its iframe when it floats or docks.
 */
export function PreviewSurfaceLayer() {
  const selected = useStore((s) => (s.selected.kind === "thread" ? s.selected.id : null))
  const previews = useStore((s) => s.previews)

  useEffect(() => {
    installPreviewSurfaceTriggers()
    installPreviewRelayListener()
    // Panels sliding in and out move slots without resizing them: follow for a while.
    return useStore.subscribe((state, previous) => {
      if (state.rightOpen !== previous.rightOpen || state.sidebarOpen !== previous.sidebarOpen || state.rightTab !== previous.rightTab || state.settingsOpen !== previous.settingsOpen || state.selected !== previous.selected || state.splitView !== previous.splitView) pokePreviewLayout()
    })
  }, [])

  const live = useMemo(() => {
    const ids: ThreadId[] = []
    const isLive = (id: string | null | undefined): id is string => {
      const preview = id ? previews[id] : undefined
      return preview?.kind === "web" && preview.entries.length > 0
    }
    const floating = Object.keys(previews).find((id) => {
      const preview = previews[id]
      return preview?.kind === "web" && preview.floating && isLive(id)
    })
    if (floating) ids.push(floating)
    if (selected && selected !== floating && isLive(selected) && !(previews[selected] as WebPreview).floating) ids.push(selected)
    // A stable order keeps surviving surfaces in place: reordering iframe siblings would reload them.
    return ids.sort()
  }, [previews, selected])

  return (
    <div className="preview-surface-layer" data-preview-layer>
      {live.map((threadId) => <PreviewSurface key={threadId} threadId={threadId} />)}
    </div>
  )
}

function PreviewSurface({ threadId }: { threadId: ThreadId }) {
  const preview = useStore((s) => s.previews[threadId])
  if (preview?.kind !== "web" || preview.entries.length === 0) return null
  return <SurfaceBody threadId={threadId} preview={preview} />
}

type Layout = { w: number; h: number; scale: number; left: number; top: number; boxW: number; boxH: number }

function frameLayout(kind: PreviewSlotKind, viewport: PreviewViewport, rect: PreviewRect, threadId: ThreadId): Layout {
  if (kind === "dock") {
    if (viewport.mode === "fill") return { w: rect.w, h: rect.h, scale: 1, left: 0, top: 0, boxW: rect.w, boxH: rect.h }
    const layout = viewportLayout({ w: viewport.width, h: viewport.height }, { w: rect.w, h: rect.h })
    return { w: viewport.width, h: viewport.height, scale: layout.scale, left: layout.left, top: layout.top, boxW: layout.width, boxH: layout.height }
  }
  // The mini player shows the page scaled to the player: the device viewport, or the layout the dock had.
  const logical = viewport.mode === "device"
    ? { w: viewport.width, h: viewport.height }
    : dockedSize.get(threadId) ?? { w: Math.round(rect.w * 1.6), h: Math.round(rect.h * 1.6) }
  const scale = Math.min(1, rect.w / logical.w, rect.h / logical.h)
  const boxW = logical.w * scale
  const boxH = logical.h * scale
  return { w: logical.w, h: logical.h, scale, left: (rect.w - boxW) / 2, top: (rect.h - boxH) / 2, boxW, boxH }
}

const SurfaceBody = memo(function SurfaceBody({ threadId, preview }: { threadId: ThreadId; preview: WebPreview }) {
  const kind: PreviewSlotKind = preview.floating ? "pip" : "dock"
  const entry = preview.entries[preview.index]
  const session = usePreviewSession(threadId)
  const slot = usePreviewSurface((s) => s.slots[kind])
  const onScreen = usePreviewSurface((s) => s.windowOnScreen)
  const exiting = usePreviewSurface((s) => s.exiting === threadId)
  const slotVisible = slot?.threadId === threadId && slot.visible
  const hasFrame = !!session.frame
  const visible = slotVisible && onScreen && hasFrame && !preview.pending
  const sandbox = entry?.target.kind === "file" ? "file" : "server"
  const device = kind === "dock" && preview.viewport.mode === "device"

  const surfaceRef = useRef<HTMLDivElement>(null)
  const chromeRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const railRefs = useRef<Partial<Record<ResizeEdge, HTMLDivElement | null>>>({})
  const badgeRef = useRef<HTMLDivElement>(null)
  const live = useRef({ viewport: preview.viewport, kind, threadId, scale: 1 })
  useLayoutEffect(() => {
    live.current = { viewport: preview.viewport, kind, threadId, scale: live.current.scale }
  }, [preview.viewport, kind, threadId])
  const expectLoad = useRef(false)
  const [ready, setReady] = useState(false)
  const [drag, setDrag] = useState<{ w: number; h: number } | null>(null)

  // Write the slot rect, the iframe's fitted size and the device rails straight to the DOM.
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const apply = (rect: PreviewRect | null, moving: boolean) => {
      const { viewport, kind: currentKind, threadId: id } = live.current
      if (!rect || rect.w <= 0 || rect.h <= 0) {
        surface.style.width = "0px"
        surface.style.height = "0px"
        return
      }
      surface.style.transform = `translate(${rect.x}px, ${rect.y}px)`
      surface.style.width = `${rect.w}px`
      surface.style.height = `${rect.h}px`
      if (moving) surface.dataset.moving = "true"
      else delete surface.dataset.moving
      if (currentKind === "dock") dockedSize.set(id, { w: Math.round(rect.w), h: Math.round(rect.h) })
      const layout = frameLayout(currentKind, viewport, rect, id)
      live.current.scale = layout.scale
      const frame = frameRef.current
      if (frame) {
        frame.style.width = `${layout.w}px`
        frame.style.height = `${layout.h}px`
        frame.style.transform = layout.scale === 1 && layout.left === 0 && layout.top === 0 ? "" : `translate(${layout.left}px, ${layout.top}px) scale(${layout.scale})`
      }
      const place = (edge: ResizeEdge, x: number, y: number, w?: number, h?: number) => {
        const rail = railRefs.current[edge]
        if (!rail) return
        rail.style.transform = `translate(${x}px, ${y}px)`
        if (w !== undefined) rail.style.width = `${w}px`
        if (h !== undefined) rail.style.height = `${h}px`
      }
      if (currentKind === "dock" && viewport.mode === "device") {
        place("e", layout.left + layout.boxW, layout.top, undefined, layout.boxH)
        place("s", layout.left, layout.top + layout.boxH, layout.boxW, undefined)
        place("se", layout.left + layout.boxW, layout.top + layout.boxH)
        const badge = badgeRef.current
        if (badge) badge.style.transform = `translate(${Math.max(0, layout.left + layout.boxW - badge.offsetWidth - 8)}px, ${Math.max(0, layout.top + layout.boxH - badge.offsetHeight - 8)}px)`
        setPreviewScale("dock", layout.scale < 1 ? Math.round(layout.scale * 100) : null)
      } else if (currentKind === "dock") setPreviewScale("dock", null)
    }
    return registerSurface({ kind, element: surface, chrome: kind === "pip" ? chromeRef.current : null, apply })
  }, [kind])
  // A viewport change moves the page inside the surface without reloading it.
  useEffect(() => {
    syncPreviewSurfaces()
  }, [preview.viewport, drag])

  // Navigate the iframe: `src` for the first document, `location.replace` after (no session-history entry in Kybern's window).
  const frameUrl = session.frame?.url
  const frameSeq = session.frame?.seq
  const navigate = (url: string) => {
    const element = frameRef.current
    if (!element) return
    expectLoad.current = true
    const current = element.getAttribute("src")
    if (!current || current === "about:blank") {
      element.src = url
      return
    }
    try {
      element.contentWindow!.location.replace(url)
    } catch {
      element.src = url
    }
  }
  const navigateRef = useRef(navigate)
  useLayoutEffect(() => {
    navigateRef.current = navigate
  })
  useEffect(() => {
    if (frameUrl) navigateRef.current(frameUrl)
  }, [frameSeq, sandbox, frameUrl])
  useEffect(() => {
    const element = frameRef.current
    if (hasFrame || !element || !element.getAttribute("src") || element.getAttribute("src") === "about:blank") return
    element.src = "about:blank"
    setReady(false)
  }, [hasFrame])
  useEffect(() => registerFrameApi(threadId, {
    navigate: (url) => navigateRef.current(url),
    post: (message) => frameRef.current?.contentWindow?.postMessage(message, "*"),
  }), [threadId])

  // Bridge messages come only from this iframe's own window, and only from file pages.
  useEffect(() => {
    if (sandbox !== "file") return
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const message = validateBridgeMessage(event.data)
      if (!message) return
      if (message.type === "nav-start") bridgeNavStart(threadId)
      else bridgeNav(threadId, message)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [sandbox, threadId])

  // Load the entry whenever navigation requests it, and again after an unload.
  const revision = preview.revision
  useEffect(() => {
    void revision
    void loadPreviewEntry(threadId)
  }, [threadId, revision])
  useEffect(() => {
    if (session.suspended && slotVisible) void loadPreviewEntry(threadId)
  }, [session.suspended, slotVisible, threadId])
  // A docked page hidden for five minutes unloads; the entry stays and reloads on show.
  useEffect(() => {
    if (visible || !hasFrame || kind !== "dock") return
    const id = window.setTimeout(() => releasePreviewFrame(threadId, { suspend: true }), PREVIEW_HIDDEN_UNLOAD_MS)
    return () => window.clearTimeout(id)
  }, [visible, hasFrame, kind, threadId])
  useEffect(() => () => releasePreviewFrame(threadId), [threadId])
  // The loading bar ends silently at 15 seconds.
  useEffect(() => {
    if (!session.loading) return
    const id = window.setTimeout(() => endLoading(threadId), LOADING_CEILING_MS)
    return () => window.clearTimeout(id)
  }, [session.loading, session.frame?.seq, threadId])

  const onLoad = () => {
    const element = frameRef.current
    if (!element || element.getAttribute("src") === "about:blank") return
    setReady(true)
    const own = expectLoad.current
    expectLoad.current = false
    frameLoaded(threadId, own)
  }

  const startRailDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const edge = event.currentTarget.dataset.edge as ResizeEdge
    const viewport = live.current.viewport
    if (viewport.mode !== "device") return
    event.preventDefault()
    const rail = event.currentTarget
    rail.setPointerCapture(event.pointerId)
    rail.dataset.active = "true"
    const surface = surfaceRef.current
    if (surface) surface.dataset.dragging = "true"
    const start = { w: viewport.width, h: viewport.height }
    const startPointer = { x: event.clientX, y: event.clientY }
    let pending: { w: number; h: number } | null = null
    let frameId = 0
    const flush = () => {
      frameId = 0
      if (!pending) return
      const size = pending
      pending = null
      useStore.getState().setPreviewViewport(threadId, { mode: "device", presetId: null, width: size.w, height: size.h })
      setDrag(size)
    }
    const move = (moveEvent: PointerEvent) => {
      pending = resizeViewport({ edge, start, startPointer, pointer: { x: moveEvent.clientX, y: moveEvent.clientY }, scale: live.current.scale, shift: moveEvent.shiftKey })
      if (!frameId) frameId = requestAnimationFrame(flush)
    }
    const end = () => {
      rail.removeEventListener("pointermove", move)
      rail.removeEventListener("pointerup", end)
      rail.removeEventListener("pointercancel", end)
      if (frameId) cancelAnimationFrame(frameId)
      flush()
      delete rail.dataset.active
      if (surface) delete surface.dataset.dragging
      setDrag(null)
    }
    rail.addEventListener("pointermove", move)
    rail.addEventListener("pointerup", end)
    rail.addEventListener("pointercancel", end)
  }
  const fitRail = (event: React.MouseEvent<HTMLDivElement>) => {
    const edge = event.currentTarget.dataset.edge as ResizeEdge
    const viewport = live.current.viewport
    const surface = surfaceRef.current
    if (viewport.mode !== "device" || !surface) return
    const slotSize = { w: surface.offsetWidth, h: surface.offsetHeight }
    let size = { w: viewport.width, h: viewport.height }
    if (edge !== "s") size = fitAxis("w", size, slotSize)
    if (edge !== "e") size = fitAxis("h", size, slotSize)
    useStore.getState().setPreviewViewport(threadId, { mode: "device", presetId: null, width: size.w, height: size.h })
  }

  const target = entry?.target
  const title = target?.kind === "file" ? `Preview of ${target.path.split("/").pop()}` : target?.kind === "server" ? `Preview of ${safeHost(target.url)}` : "Preview"

  return (
    <div
      ref={surfaceRef}
      className="preview-surface"
      data-visible={visible}
      data-shape={kind}
      data-device={device || undefined}
      data-exiting={exiting || undefined}
      data-preview-surface={threadId}
      inert={!visible}
    >
      {kind === "pip" && <div ref={chromeRef} className="preview-pip-chrome" role="region" aria-label="Floating preview" />}
      <iframe
        key={sandbox}
        ref={frameRef}
        title={title}
        sandbox={sandbox === "file" ? FILE_SANDBOX : SERVER_SANDBOX}
        referrerPolicy="no-referrer"
        allow="clipboard-write; fullscreen"
        loading="eager"
        className="preview-surface__frame"
        data-ready={ready}
        data-device={device || undefined}
        onLoad={onLoad}
      />
      {device && (
        <>
          <div ref={(node) => { railRefs.current.e = node }} className="preview-rail" data-edge="e" onPointerDown={startRailDrag} onDoubleClick={fitRail} />
          <div ref={(node) => { railRefs.current.s = node }} className="preview-rail" data-edge="s" onPointerDown={startRailDrag} onDoubleClick={fitRail} />
          <div ref={(node) => { railRefs.current.se = node }} className="preview-rail" data-edge="se" onPointerDown={startRailDrag} onDoubleClick={fitRail} />
          {drag && <div ref={badgeRef} className="preview-badge" aria-hidden>{drag.w} × {drag.h}</div>}
        </>
      )}
    </div>
  )
})

function safeHost(url: string): string {
  try { return new URL(url).host } catch { return url }
}
