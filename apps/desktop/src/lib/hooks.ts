import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import { shouldCommitReveal, smoothAdvance, type SmoothState } from "./smoothStream"

/**
 * Reveal streaming text at a steady, provider-agnostic cadence. `target` is the
 * full text received so far and `live` is true while the turn is still running;
 * `complete` lets the reveal drain faster once the message is fully received.
 * Settled/historical text (live=false) shows in full immediately — the reveal
 * only runs for text arriving live. See `smoothStream.ts` for the pacing model.
 */
export function useSmoothStream(target: string, live: boolean, complete = false): string {
  const [shownLen, setShownLen] = useState(() => (live ? 0 : target.length))
  // Loop bookkeeping and the latest inputs, read only inside effects / the rAF
  // callback so a flurry of deltas never restarts (and re-times) the animation.
  const loop = useRef<{ state: SmoothState; raf: number; last: number; emitted: number; lastEmit: number }>({
    state: { shown: live ? 0 : target.length, vel: 0 },
    raf: 0,
    last: 0,
    emitted: live ? 0 : target.length,
    lastEmit: 0,
  })
  const latest = useRef({ target, complete })

  useEffect(() => {
    latest.current = { target, complete }
  }, [target, complete])

  // Start the reveal when there is a backlog; leave a running loop alone. New
  // deltas re-run this effect (no cleanup), which no-ops while the loop drains —
  // and because the jitter buffer keeps text in reserve, a steady stream never
  // drains to the end, so the loop keeps ticking instead of stopping per chunk.
  useEffect(() => {
    const l = loop.current
    if (!live) {
      if (l.raf) cancelAnimationFrame(l.raf)
      l.raf = 0
      l.state = { shown: target.length, vel: 0 }
      l.emitted = target.length
      l.lastEmit = 0
      return
    }
    if (l.state.shown > target.length) l.state = { shown: 0, vel: 0 } // shrank: restart
    if (l.raf || l.state.shown >= target.length) return
    l.last = 0
    const tick = (now: number) => {
      const { target: t, complete: done } = latest.current
      const last = l.last || now
      l.last = now
      l.state = smoothAdvance(l.state, t.length, now - last, done)
      const next = Math.floor(l.state.shown)
      if (shouldCommitReveal(l.emitted, next, t.length, l.lastEmit ? now - l.lastEmit : Infinity)) {
        l.emitted = next
        l.lastEmit = now
        setShownLen(next)
      }
      l.raf = l.state.shown < t.length ? requestAnimationFrame(tick) : 0
    }
    l.raf = requestAnimationFrame(tick)
  }, [target, live])

  useEffect(() => {
    const l = loop.current
    return () => {
      cancelAnimationFrame(l.raf)
      l.raf = 0
    }
  }, [])

  if (!live) return target
  return target.slice(0, Math.min(shownLen, target.length))
}

/** Keeps a scroll container pinned to the bottom while the user has not scrolled up. */
export function useStickToBottom<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null)
  const pinned = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    pinned.current = gap < 48
    setAtBottom(pinned.current)
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !pinned.current) return
    el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  const scrollToBottom = useCallback((smooth = true) => {
    const el = ref.current
    if (!el) return
    pinned.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
  }, [])

  return { ref, onScroll, atBottom, scrollToBottom }
}

/** Live-updating "now" for relative timestamps. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** Ticks every second while `active`. Cheap for elapsed-time labels. */
export function useTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
  return now
}

type Handler = (e: KeyboardEvent) => void

/** Global shortcut. `combo` like "mod+k", "mod+shift+c", "escape". */
export function useHotkey(combo: string, handler: Handler, opts: { enabled?: boolean; allowInInput?: boolean } = {}) {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    if (opts.enabled === false) return
    const parts = combo.toLowerCase().split("+")
    const key = parts[parts.length - 1]!
    const wantMod = parts.includes("mod")
    const wantShift = parts.includes("shift")
    const wantAlt = parts.includes("alt")
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (wantMod !== mod || wantShift !== e.shiftKey || wantAlt !== e.altKey) return
      // Shift changes `event.key` for punctuation (for example `\` becomes
      // `|`), while `event.code` keeps the physical shortcut key stable.
      const keyMatches = e.key.toLowerCase() === key || (key === "\\" && e.code === "Backslash")
      if (!keyMatches) return
      if (!opts.allowInInput) {
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && !wantMod) return
      }
      e.preventDefault()
      ref.current(e)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [combo, opts.enabled, opts.allowInInput])
}

/** Pointer-driven horizontal resize, 1:1 with the drag. */
export function useResize(opts: { initial: number; min: number; max: number; side: "left" | "right"; storageKey?: string }) {
  const [width, setWidth] = useState(() => {
    if (opts.storageKey) {
      try {
        const v = Number(localStorage.getItem(opts.storageKey))
        if (v >= opts.min && v <= opts.max) return v
      } catch {
        // ignore
      }
    }
    return opts.initial
  })
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = width
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)
      setDragging(true)
      document.body.style.cursor = "col-resize"
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX
        const next = Math.min(opts.max, Math.max(opts.min, opts.side === "left" ? startW + dx : startW - dx))
        setWidth(next)
      }
      const up = () => {
        setDragging(false)
        document.body.style.cursor = ""
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
        setWidth((w) => {
          if (opts.storageKey) {
            try {
              localStorage.setItem(opts.storageKey, String(w))
            } catch {
              // ignore
            }
          }
          return w
        })
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    },
    [width, opts.min, opts.max, opts.side, opts.storageKey],
  )

  return { width, dragging, onPointerDown }
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (v: T | ((p: T) => T)) => {
      setValue((p) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(p) : v
        try {
          localStorage.setItem(key, JSON.stringify(next))
        } catch {
          // ignore
        }
        return next
      })
    },
    [key],
  )
  return [value, set]
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement("textarea")
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand("copy")
    ta.remove()
  }
}
