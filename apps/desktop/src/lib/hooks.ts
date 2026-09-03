import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

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
      if (e.key.toLowerCase() !== key) return
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
