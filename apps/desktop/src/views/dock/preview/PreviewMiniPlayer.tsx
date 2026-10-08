import { animate, useReducedMotion } from "motion/react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { IconButton } from "@/components/kit/icon-button"
import { PictureInPictureExitIcon, XIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import { usePreviewSession } from "@/state/previewSession"
import { dockedSize, exitFloatingPreview, registerSlot, syncPreviewSurfaces, usePreviewSurface, type PreviewRect } from "@/state/previewSurface"
import { useStore } from "@/state/store"
import {
  clampPlayerSize,
  cornerPosition,
  defaultPlayerSize,
  isPlayerCorner,
  nearestCorner,
  PLAYER_GAP,
  resizeHandleCorner,
  type PlayerCorner,
  type PlayerSize,
} from "../../../../../../packages/kybern-client/src/previewMiniPlayer"
import { currentAddress } from "./previewAddress"

type Bounds = { left: number; top: number; w: number; h: number; bottomInset: number }

const HYSTERESIS_PX = 4
const VELOCITY_WINDOW_MS = 100

function prefsKey(): string {
  return `kybern.preview.pip.${useStore.getState().environmentId}`
}
function readPrefs(): { corner?: PlayerCorner; size?: PlayerSize } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(prefsKey()) ?? "null")
    if (!parsed || typeof parsed !== "object") return {}
    const { corner, w, h } = parsed as { corner?: unknown; w?: unknown; h?: unknown }
    return {
      corner: isPlayerCorner(corner) ? corner : undefined,
      size: typeof w === "number" && typeof h === "number" ? { w, h } : undefined,
    }
  } catch {
    return {}
  }
}
function writePrefs(corner: PlayerCorner, size: PlayerSize): void {
  try { localStorage.setItem(prefsKey(), JSON.stringify({ corner, w: size.w, h: size.h })) } catch { /* a per-viewer convenience */ }
}

/** The active chat column, minus the composer (plus a 12px gap above it). */
function measureBounds(): Bounds | null {
  const main = document.querySelector<HTMLElement>("main[data-workspace-chat]")
  if (!main) return null
  const box = main.getBoundingClientRect()
  let composerTop = Infinity
  main.querySelectorAll<HTMLElement>(".chat-composer-shell, .chat-composer-surface").forEach((element) => {
    const top = element.getBoundingClientRect().top
    if (top > box.top && top < composerTop) composerTop = top
  })
  const bottomInset = Number.isFinite(composerTop) ? Math.max(PLAYER_GAP, box.bottom - composerTop + PLAYER_GAP) : PLAYER_GAP
  return { left: box.left, top: box.top, w: box.width, h: box.height, bottomInset }
}

/** Mounted once in the app shell. Shows nothing until a page floats. */
export function PreviewMiniPlayer() {
  const threadId = useStore((s) => {
    for (const [id, preview] of Object.entries(s.previews)) {
      if (preview.kind === "web" && preview.floating && preview.entries.length > 0) return id
    }
    return null
  })
  return threadId ? <MiniPlayer key={threadId} threadId={threadId} /> : null
}

function MiniPlayer({ threadId }: { threadId: ThreadId }) {
  const host = usePreviewSurface((s) => s.elements.pip)
  const reduceMotion = useReducedMotion() ?? false
  const [corner, setCornerState] = useState<PlayerCorner>(() => readPrefs().corner ?? "bottom-right")
  const state = useRef({
    bounds: null as Bounds | null,
    pos: { x: 0, y: 0 },
    size: { w: 320, h: 200 } as PlayerSize,
    corner,
    ready: false,
  })
  const animations = useRef<{ stop: () => void }[]>([])
  const headerRef = useRef<HTMLDivElement>(null)

  const stopAnimations = () => {
    animations.current.forEach((animation) => animation.stop())
    animations.current = []
  }
  const place = (nextCorner: PlayerCorner) => {
    const { bounds, size } = state.current
    if (!bounds) return
    state.current.pos = cornerPosition(nextCorner, size, { w: bounds.w, h: bounds.h }, { bottomInset: bounds.bottomInset })
  }
  const repin = () => {
    const bounds = measureBounds()
    if (!bounds) return
    const s = state.current
    s.bounds = bounds
    if (!s.ready) {
      const prefs = readPrefs()
      const docked = dockedSize.get(threadId)
      s.size = prefs.size ? clampPlayerSize(prefs.size, bounds) : defaultPlayerSize(docked ?? { w: 16, h: 10 }, bounds)
      s.ready = true
    } else s.size = clampPlayerSize(s.size, bounds)
    place(s.corner)
    syncPreviewSurfaces()
  }

  // The slot: where the floating page goes, read from the player's own geometry.
  useLayoutEffect(() => {
    repin()
    const rect = (): PreviewRect | null => {
      const { bounds, pos, size } = state.current
      return bounds ? { x: bounds.left + pos.x, y: bounds.top + pos.y, w: size.w, h: size.h } : null
    }
    const unregister = registerSlot("pip", { threadId, rect }, true)
    syncPreviewSurfaces()
    return () => {
      stopAnimations()
      unregister()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  // Keep the player inside the column and clear of the composer as they resize.
  useEffect(() => {
    const observer = new ResizeObserver(() => repin())
    const watch = () => {
      const main = document.querySelector<HTMLElement>("main[data-workspace-chat]")
      if (main) {
        observer.observe(main)
        main.querySelectorAll(".chat-composer-shell, .chat-composer-surface").forEach((element) => observer.observe(element))
      }
    }
    watch()
    const retry = window.setInterval(() => { observer.disconnect(); watch() }, 4000)
    window.addEventListener("resize", repin)
    return () => {
      window.clearInterval(retry)
      observer.disconnect()
      window.removeEventListener("resize", repin)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setCorner = (next: PlayerCorner) => {
    state.current.corner = next
    setCornerState(next)
    writePrefs(next, state.current.size)
  }

  const onHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button") || event.button !== 0) return
    const header = event.currentTarget
    const s = state.current
    if (!s.bounds) return
    stopAnimations() // interruptible: grab it mid-flight and it follows from where it is
    header.setPointerCapture(event.pointerId)
    const start = { px: event.clientX, py: event.clientY, x: s.pos.x, y: s.pos.y }
    const samples: { t: number; x: number; y: number }[] = [{ t: performance.now(), x: s.pos.x, y: s.pos.y }]
    let dragging = false
    const surface = header.closest<HTMLElement>(".preview-surface")
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - start.px
      const dy = moveEvent.clientY - start.py
      if (!dragging) {
        if (Math.hypot(dx, dy) < HYSTERESIS_PX) return
        dragging = true
        header.dataset.dragging = "true"
        if (surface) surface.dataset.dragging = "true"
      }
      const bounds = s.bounds!
      s.pos = {
        x: Math.min(Math.max(PLAYER_GAP, start.x + dx), Math.max(PLAYER_GAP, bounds.w - PLAYER_GAP - s.size.w)),
        y: Math.min(Math.max(PLAYER_GAP, start.y + dy), Math.max(PLAYER_GAP, bounds.h - bounds.bottomInset - s.size.h)),
      }
      const now = performance.now()
      samples.push({ t: now, x: s.pos.x, y: s.pos.y })
      while (samples.length > 2 && now - samples[0].t > VELOCITY_WINDOW_MS) samples.shift()
      syncPreviewSurfaces()
    }
    const end = () => {
      header.removeEventListener("pointermove", move)
      header.removeEventListener("pointerup", end)
      header.removeEventListener("pointercancel", end)
      delete header.dataset.dragging
      if (surface) delete surface.dataset.dragging
      if (!dragging) return
      const bounds = s.bounds
      if (!bounds) return
      const first = samples[0]
      const last = samples[samples.length - 1]
      const span = Math.max(1, last.t - first.t)
      const velocity = { x: ((last.x - first.x) / span) * 1000, y: ((last.y - first.y) / span) * 1000 }
      const next = nearestCorner(s.pos, velocity, s.size, { w: bounds.w, h: bounds.h }, { bottomInset: bounds.bottomInset })
      setCorner(next)
      const target = cornerPosition(next, s.size, { w: bounds.w, h: bounds.h }, { bottomInset: bounds.bottomInset })
      if (reduceMotion) {
        // No spring: fade out, jump to the corner, fade back in.
        usePreviewSurface.setState({ exiting: threadId })
        window.setTimeout(() => {
          s.pos = target
          syncPreviewSurfaces()
          usePreviewSurface.setState({ exiting: null })
        }, 150)
        return
      }
      // Independent springs per axis, each handed the release velocity.
      animations.current = [
        animate(s.pos.x, target.x, { type: "spring", bounce: 0, duration: 0.4, velocity: velocity.x, onUpdate: (x) => { s.pos = { ...s.pos, x }; syncPreviewSurfaces() } }),
        animate(s.pos.y, target.y, { type: "spring", bounce: 0, duration: 0.4, velocity: velocity.y, onUpdate: (y) => { s.pos = { ...s.pos, y }; syncPreviewSurfaces() } }),
      ]
    }
    header.addEventListener("pointermove", move)
    header.addEventListener("pointerup", end)
    header.addEventListener("pointercancel", end)
  }

  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const s = state.current
    if (!s.bounds || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    stopAnimations()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const surface = handle.closest<HTMLElement>(".preview-surface")
    if (surface) surface.dataset.dragging = "true"
    const start = { px: event.clientX, py: event.clientY, w: s.size.w, h: s.size.h, x: s.pos.x, y: s.pos.y }
    const right = s.corner.endsWith("right")
    const bottom = s.corner.startsWith("bottom")
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - start.px
      const dy = moveEvent.clientY - start.py
      const bounds = s.bounds!
      const size = clampPlayerSize({ w: right ? start.w - dx : start.w + dx, h: bottom ? start.h - dy : start.h + dy }, { w: bounds.w, h: bounds.h })
      s.size = size
      // The pinned corner stays put; the opposite edges follow the pointer.
      s.pos = { x: right ? start.x + start.w - size.w : start.x, y: bottom ? start.y + start.h - size.h : start.y }
      syncPreviewSurfaces()
    }
    const end = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", end)
      handle.removeEventListener("pointercancel", end)
      if (surface) delete surface.dataset.dragging
      writePrefs(s.corner, s.size)
      place(s.corner)
      syncPreviewSurfaces()
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", end)
    handle.addEventListener("pointercancel", end)
  }

  const leave = (reveal: boolean) => {
    const done = () => {
      const selected = useStore.getState().selected
      if (reveal && !(selected.kind === "thread" && selected.id === threadId)) useStore.getState().selectThread(threadId)
      useStore.getState().setPreviewFloating(threadId, false, { reveal })
    }
    if (reduceMotion) done()
    else exitFloatingPreview(threadId, done)
  }

  if (!host) return null
  return createPortal(
    <PlayerChrome
      threadId={threadId}
      headerRef={headerRef}
      handleCorner={resizeHandleCorner(corner)}
      onHeaderPointerDown={onHeaderPointerDown}
      onResizePointerDown={onResizePointerDown}
      onReturn={() => leave(true)}
      onClose={() => leave(false)}
    />,
    host,
  )
}

function PlayerChrome({
  threadId,
  headerRef,
  handleCorner,
  onHeaderPointerDown,
  onResizePointerDown,
  onReturn,
  onClose,
}: {
  threadId: ThreadId
  headerRef: React.RefObject<HTMLDivElement | null>
  handleCorner: PlayerCorner
  onHeaderPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onResizePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onReturn: () => void
  onClose: () => void
}) {
  const preview = useStore((s) => s.previews[threadId])
  const session = usePreviewSession(threadId)
  const selectedElsewhere = useStore((s) => !(s.selected.kind === "thread" && s.selected.id === threadId))
  const threadTitle = useStore((s) => s.threads[threadId]?.title)
  const entry = preview?.kind === "web" ? preview.entries[preview.index] : undefined
  const title = entry ? entry.title ?? currentAddress(threadId, entry.target, session.bridgePath).segments.map((segment) => segment.text).join("") : "Preview"
  return (
    <>
      <div
        ref={headerRef}
        onPointerDown={onHeaderPointerDown}
        className="preview-pip__header group/pip font-system-ui"
        data-preview-pip-header
      >
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-foreground/90" title={title}>{title}</span>
        {selectedElsewhere && threadTitle && (
          <span className="hidden max-w-[40%] shrink truncate text-[11px] leading-4 text-muted-foreground group-hover/pip:block">{threadTitle}</span>
        )}
        <IconButton variant="chrome" size="icon-xs" className={cn("!size-6 !min-w-6 !px-0")} label="Return to panel" tooltip="Return to panel" tooltipSide="bottom" onClick={onReturn}>
          <PictureInPictureExitIcon className="size-3.5" />
        </IconButton>
        <IconButton variant="chrome" size="icon-xs" className={cn("!size-6 !min-w-6 !px-0")} label="Close" tooltip="Close" tooltipSide="bottom" onClick={onClose}>
          <XIcon className="size-3.5" />
        </IconButton>
      </div>
      <div className="preview-pip__resize" data-corner={handleCorner} onPointerDown={onResizePointerDown} />
    </>
  )
}
