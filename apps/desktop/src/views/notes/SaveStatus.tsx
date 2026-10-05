import { useEffect, useRef, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"
import type { SessionSnapshot } from "@/state/noteSession"

/** "Saving…" appears only when a save takes this long; quick saves just say "Saved". */
const SAVING_DELAY_MS = 700
/** "Saved" stays this long, then fades. */
const SAVED_LINGER_MS = 2000
const FADE_MS = 150

type Shown = { text: string; trouble: boolean }

/**
 * What to say now, or null for nothing. Quiet by design: nothing before the first edit,
 * "Saving…" only for a slow save, "Saved" for a moment, trouble until it clears.
 */
function useStatus(snapshot: Pick<SessionSnapshot, "save" | "saveError" | "deleted" | "phase">): { shown: Shown | null; visible: boolean; everShown: boolean } {
  const [shown, setShown] = useState<Shown | null>(null)
  const [visible, setVisible] = useState(false)
  const [everShown, setEverShown] = useState(false)
  const edited = useRef(false)

  const { save, saveError, deleted, phase } = snapshot
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    const show = (next: Shown | null) => {
      if (next) {
        setShown(next)
        setVisible(true)
        setEverShown(true)
      } else {
        setVisible(false)
        timers.push(setTimeout(() => setShown(null), FADE_MS))
      }
    }
    if (phase !== "ready" || deleted) {
      show(null)
    } else if (save === "dirty") {
      // Typing, or the editor settling on its own text when a note opens. Only a real save counts as an edit.
      show(null)
    } else if (save === "saving") {
      edited.current = true
      timers.push(setTimeout(() => show({ text: "Saving…", trouble: false }), SAVING_DELAY_MS))
    } else if (save === "saved") {
      if (edited.current) {
        show({ text: "Saved", trouble: false })
        timers.push(setTimeout(() => show(null), SAVED_LINGER_MS))
      }
    } else {
      edited.current = true
      // A conflict has its own banner with the details; the header only says nothing was saved.
      show(
        save === "conflict"
          ? { text: "Not saved", trouble: false }
          : { text: save === "retrying" ? "Couldn’t save. Retrying…" : saveError ? `Couldn’t save. ${saveError}` : "Couldn’t save", trouble: true },
      )
    }
    return () => timers.forEach(clearTimeout)
  }, [save, saveError, deleted, phase])

  return { shown, visible, everShown }
}

/**
 * The quiet word beside a note. Routine states are not announced; only trouble is.
 * `idle` shows in the same place while there is nothing to report;
 * `reserveSpace` keeps the line once the status has appeared.
 */
export function SaveStatus({ snapshot, className, idle, reserveSpace }: { snapshot: SessionSnapshot; className?: string; idle?: ReactNode; reserveSpace?: boolean }) {
  const { shown, visible, everShown } = useStatus(snapshot)
  // Once the status has appeared, keep its line, so the panel does not bounce as it fades.
  if (!shown && reserveSpace && everShown) return <span aria-hidden="true" className={cn("invisible select-none text-[length:var(--app-font-size-ui-sm,11px)]", className)}>&nbsp;</span>
  if (!shown) return idle ? <span className={cn("inline-flex min-w-0 select-none text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground/60", className)}>{idle}</span> : null
  return (
    <span
      role={shown.trouble ? "alert" : undefined}
      aria-live={shown.trouble ? undefined : "off"}
      className={cn(
        "inline-flex min-w-0 max-w-full select-none text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums transition-opacity duration-150 ease-out motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0",
        shown.trouble ? "text-destructive" : "text-muted-foreground/60",
        className,
      )}
      title={shown.text}
    >
      <span className="truncate">{shown.text}</span>
    </span>
  )
}
