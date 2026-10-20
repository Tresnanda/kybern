import { usePresence } from "motion/react"
import { useEffect, useRef } from "react"

/** Drives the `t-toast` enter and exit of a card held by `AnimatePresence`. */
export function useToastPresence() {
  const [present, safeToRemove] = usePresence()
  const element = useRef<HTMLElement>(null)
  const remove = useRef(safeToRemove)
  useEffect(() => {
    remove.current = safeToRemove
  }, [safeToRemove])
  useEffect(() => {
    const node = element.current
    if (!node) return
    let timer: ReturnType<typeof setTimeout> | undefined
    if (present) {
      node.getBoundingClientRect()
      node.classList.add("is-open")
    } else {
      node.classList.remove("is-open")
      const duration = getComputedStyle(node)
        .getPropertyValue("--toast-close")
        .trim()
      const ms = duration.endsWith("ms")
        ? parseFloat(duration)
        : parseFloat(duration) * 1000
      timer = setTimeout(
        () => remove.current?.(),
        matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : Number.isFinite(ms)
            ? ms
            : 250
      )
    }
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [present])
  return { element, present }
}
