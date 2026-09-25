// A small floating view of what the agent sees while it uses an app on this Mac.
// Frames come from the agent's own steps (the daemon only captures them while a
// view is polling), so the picture updates step by step rather than as video.
// Polling runs only while the turn runs and the window is on screen.

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"

import { Maximize2, Minimize2, XIcon } from "@/lib/kit/icons"
import type { ComputerFrame, ThreadId } from "@/protocol"
import { rpc } from "@/state/rpc"
import { useStore } from "@/state/store"
import { observeLoopVisibility } from "@/lib/loopVisibility"
import { isWindowOnScreen } from "@/state/windowSurface"

const POLL_MS = 700
/** Keep the last picture up briefly after the turn ends so the result is visible. */
const LINGER_MS = 12_000
/** A frame older than the running turn belongs to earlier work. */
const STALE_MS = 5_000
const EXIT_MS = 150

type Corner = "top-end" | "top-start" | "bottom-end" | "bottom-start"
const CORNERS: readonly Corner[] = ["top-end", "top-start", "bottom-end", "bottom-start"]
const CORNER_KEY = "kybern.computerLiveView.corner"
const MARGIN = 12

function savedCorner(): Corner {
  try {
    const value = localStorage.getItem(CORNER_KEY)
    if (CORNERS.includes(value as Corner)) return value as Corner
  } catch {
    // Storage can be unavailable; the default corner is fine.
  }
  return "top-end"
}

/** Where a throw would come to rest (Apple, Designing Fluid Interfaces). */
function project(velocity: number, rate = 0.998): number {
  return ((velocity / 1000) * rate) / (1 - rate)
}

function frameSource(frame: ComputerFrame): string {
  return `data:${frame.media_type};base64,${frame.data}`
}

function ago(from: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(from).getTime()) / 1000))
  if (seconds < 3) return "now"
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.round(seconds / 60)}m ago`
}

export function ComputerLiveView({ threadId, running, insetEnd = 0, insetBottom = 0 }: { threadId: ThreadId; running: boolean; insetEnd?: number; insetBottom?: number }) {
  const enabled = useStore((s) => s.settings?.computer_use?.enabled ?? false)
  const [frame, setFrame] = useState<{ value: ComputerFrame; run: number } | null>(null)
  const [previous, setPrevious] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // Each turn is a run. Dismissing or finishing hides the view for that run only.
  const [run, setRun] = useState(0)
  const [wasRunning, setWasRunning] = useState(running)
  const [dismissedRun, setDismissedRun] = useState(-1)
  const [finishedRun, setFinishedRun] = useState(-1)
  if (wasRunning !== running) {
    setWasRunning(running)
    if (running) setRun((value) => value + 1)
  }
  const lastSeq = useRef<number | null>(null)
  const card = useRef<HTMLElement>(null)
  const [corner, setCorner] = useState<Corner>(savedCorner)
  const drag = useRef<{ id: number; x: number; y: number; samples: { x: number; y: number; t: number }[] } | null>(null)
  const settleFrom = useRef<DOMRect | null>(null)

  // After a corner change, start the move from where the card was released.
  useLayoutEffect(() => {
    const element = card.current
    const from = settleFrom.current
    if (!element || !from) return
    settleFrom.current = null
    const to = element.getBoundingClientRect()
    element.dataset.dragging = ""
    element.style.translate = `${from.left - to.left}px ${from.top - to.top}px`
    void element.offsetWidth
    delete element.dataset.dragging
    element.style.translate = ""
  }, [corner])

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const element = card.current
    if (!element || event.button !== 0 || (event.target as HTMLElement).closest("button")) return
    element.setPointerCapture(event.pointerId)
    element.dataset.dragging = ""
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, samples: [{ x: event.clientX, y: event.clientY, t: event.timeStamp }] }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    const element = card.current
    if (!current || !element || current.id !== event.pointerId) return
    element.style.translate = `${event.clientX - current.x}px ${event.clientY - current.y}px`
    current.samples.push({ x: event.clientX, y: event.clientY, t: event.timeStamp })
    while (current.samples.length > 2 && event.timeStamp - current.samples[0]!.t > 100) current.samples.shift()
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    const element = card.current
    if (!current || !element || current.id !== event.pointerId) return
    drag.current = null
    const bounds = (element.offsetParent as HTMLElement | null)?.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    const first = current.samples[0]!
    const last = current.samples.at(-1)!
    const elapsed = Math.max(1, last.t - first.t)
    const x = rect.left + rect.width / 2 + project(((last.x - first.x) / elapsed) * 1000)
    const y = rect.top + rect.height / 2 + project(((last.y - first.y) / elapsed) * 1000)
    const rtl = getComputedStyle(element).direction === "rtl"
    const left = bounds ? x < bounds.left + bounds.width / 2 : false
    const top = bounds ? y < bounds.top + bounds.height / 2 : true
    const next: Corner = `${top ? "top" : "bottom"}-${left !== rtl ? "start" : "end"}`
    if (next === corner) {
      delete element.dataset.dragging
      requestAnimationFrame(() => (element.style.translate = ""))
      return
    }
    settleFrom.current = rect
    element.style.translate = ""
    try {
      localStorage.setItem(CORNER_KEY, next)
    } catch {
      // Remembering the corner is a convenience.
    }
    setCorner(next)
  }

  useEffect(() => {
    if (!enabled || !running) return
    const startedAt = Date.now()
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!document.hidden && isWindowOnScreen()) {
        try {
          const result = await rpc().call("computer.frame", { thread_id: threadId, after: lastSeq.current })
          const next = result.frame
          if (next && !cancelled) {
            if (new Date(next.captured_at).getTime() < startedAt - STALE_MS) {
              lastSeq.current = next.seq
            } else {
              // Decode before swapping so the picture never blinks empty. The
              // frame only counts as seen once shown, so a restart refetches it.
              const image = new Image()
              image.onload = () => {
                if (cancelled) return
                lastSeq.current = next.seq
                setFrame((current) => {
                  setPrevious(current && current.run === run ? frameSource(current.value) : null)
                  return { value: next, run }
                })
                setNow(Date.now())
              }
              image.src = frameSource(next)
            }
          }
        } catch {
          // An older daemon or a dropped connection only pauses the view.
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [enabled, running, threadId, run])

  // After the turn ends, keep the result up briefly, then let it go.
  useEffect(() => {
    if (running) return
    const id = setTimeout(() => setFinishedRun(run), LINGER_MS)
    return () => clearTimeout(id)
  }, [running, run])

  // The working dot pulses only while the card is actually visible.
  const mounted = !!frame
  useEffect(() => {
    const element = card.current
    if (!mounted || !element) return
    return observeLoopVisibility(element)
  }, [mounted])

  const shown = !!frame && frame.run === run && dismissedRun !== run && finishedRun !== run
  const closing = !!frame && !shown

  // Relative time ticks only while the card is up; a closing card unmounts after its fade.
  useEffect(() => {
    if (!frame) return
    if (closing) {
      const id = setTimeout(() => {
        setFrame(null)
        setPrevious(null)
      }, EXIT_MS)
      return () => clearTimeout(id)
    }
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [frame, closing])

  if (!frame) return null
  const current = frame.value
  const source = frameSource(current)
  // The picture is the card: size it to the window's own shape, capped per size.
  const aspect = current.width > 0 && current.height > 0 ? current.width / current.height : 16 / 10
  const limits = expanded ? { width: 520, height: 480, min: 280 } : { width: 320, height: 360, min: 208 }
  const width = Math.max(limits.min, Math.round(Math.min(limits.width, limits.height * aspect)))
  // Narrow (portrait) windows show their own title bar; keep the chip for the action.
  const showApp = width >= 260
  const height = Math.round(width / aspect)
  const action = current.action ?? (running ? "Working" : "Done")
  return (
    <section
      ref={card}
      aria-label={`What the agent sees in ${current.app}`}
      data-closing={closing || undefined}
      data-corner={corner}
      className="computer-live-view group absolute z-20 max-w-[calc(100%-24px)] overflow-hidden rounded-2xl bg-black"
      style={{
        width,
        height,
        ...(corner.startsWith("top") ? { top: MARGIN } : { bottom: MARGIN + insetBottom }),
        ...(corner.endsWith("end") ? { insetInlineEnd: MARGIN + insetEnd } : { insetInlineStart: MARGIN }),
        ...(previous ? { backgroundImage: `url(${previous})` } : {}),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img key={current.seq} src={source} alt={current.title ? `${current.app}: ${current.title}` : current.app} className="computer-live-frame-image absolute inset-0 size-full object-cover" draggable={false} />
      {current.point && (
        <span
          key={`marker:${current.seq}`}
          aria-hidden
          className="computer-live-marker"
          style={{ left: `${current.point[0] * 100}%`, top: `${current.point[1] * 100}%` }}
        />
      )}
      <div aria-hidden className="computer-live-scrim" />
      <p className="computer-live-chip" title={`${current.app} · ${action} · ${ago(current.captured_at, now)}`}>
        <span aria-hidden className="computer-live-dot" data-running={running || undefined} />
        {showApp && <span className="shrink-0 text-white">{current.app}</span>}
        {showApp && <span aria-hidden className="text-white/45">·</span>}
        <span className={showApp ? "min-w-0 truncate text-white/75" : "min-w-0 truncate text-white"}>{action}</span>
      </p>
      <div className="computer-live-controls">
        <button type="button" aria-label={expanded ? "Show smaller" : "Show larger"} onClick={() => setExpanded((value) => !value)}>
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </button>
        <button type="button" aria-label="Hide until the next task" onClick={() => setDismissedRun(run)}>
          <XIcon />
        </button>
      </div>
    </section>
  )
}
