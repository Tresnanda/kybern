// Filter chips across the top of the composer's @ picker: All, Threads, Notes,
// Tasks, Files, Plugins. One sliding pill marks the selection (the shared
// `.t-tabs` motion, still under reduced motion). The chips never take focus:
// the editor keeps the caret, and ←/→ in the editor switch chips until a term is typed.

import { useSlidingPill } from "@/lib/kit/slidingPill"
import { cn } from "@/lib/utils"

import { COMPOSER_PICKER_OPTION_RADIUS_CLASS_NAME } from "./composerPickerStyles"

export interface ComposerMentionChip<T extends string> {
  id: T
  label: string
}

export function ComposerMentionChips<T extends string>({
  chips,
  active,
  onSelect,
  controls,
}: {
  chips: readonly ComposerMentionChip<T>[]
  active: T
  onSelect: (id: T) => void
  /** The id of the result list the chips filter. */
  controls: string
}) {
  // Mounted with the picker, so the pill lands in place on open and slides after.
  const [ref, pillStyle, pillReady] = useSlidingPill<HTMLDivElement>(active)
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Filter mentions"
      className={cn(
        "t-tabs mx-1.5 mt-1.5 flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        COMPOSER_PICKER_OPTION_RADIUS_CLASS_NAME,
      )}
    >
      <span aria-hidden className="t-tabs-pill z-0 bg-[var(--color-background-button-secondary)]" style={pillStyle} data-ready={pillReady} />
      {chips.map((chip) => {
        const selected = chip.id === active
        return (
          <button
            key={chip.id}
            type="button"
            role="tab"
            tabIndex={-1}
            aria-selected={selected}
            aria-controls={controls}
            data-tab-active={selected}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(chip.id)}
            className={cn(
              "relative z-[1] h-6 shrink-0 px-2.5 text-[length:var(--app-font-size-ui-sm,11px)] whitespace-nowrap transition-colors duration-100 outline-none motion-reduce:transition-none",
              COMPOSER_PICKER_OPTION_RADIUS_CLASS_NAME,
              selected ? "text-foreground" : "text-muted-foreground/75 hover:text-foreground",
            )}
          >
            {chip.label}
          </button>
        )
      })}
    </div>
  )
}
