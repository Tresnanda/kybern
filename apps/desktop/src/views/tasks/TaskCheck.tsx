// The checkbox that shares a row's status glyph slot and sits in a card's top-right
// corner: hover shows it, a click picks the task. It never opens or drags the task.
import type { MouseEvent } from "react"

import type { pressProps } from "./checkActions"

/** The 14px box and tick. Checked or not, it is drawn from the same SVG. */
export function TaskCheckBox({ taskKey, selected, onClick, ...press }: { taskKey: string; selected: boolean; onClick?: (event: MouseEvent) => void } & Partial<typeof pressProps>) {
  return (
    <span className="tk-check" role="checkbox" aria-checked={selected} aria-label={`Select ${taskKey}`} tabIndex={-1} onClick={onClick} {...press}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <rect className="box" x="1.25" y="1.25" width="11.5" height="11.5" rx="3.25" />
        <path className="tick" d="M4.3 7.2 6.1 9 9.7 5.2" />
      </svg>
    </span>
  )
}
