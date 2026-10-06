// What a click on a task's checkbox (or the cell that holds it) does.
import type { MouseEvent, PointerEvent } from "react"

import { selectRangeTo, setFocusedTask, toggleSelected } from "@/state/tasks"

/** A click on the checkbox or its cell: ⇧ extends a range (list), anything else toggles. */
export function pickTask(event: MouseEvent, id: string, allowRange: boolean) {
  event.stopPropagation()
  event.preventDefault()
  setFocusedTask(id)
  if (allowRange && event.shiftKey) selectRangeTo(id)
  else toggleSelected(id)
}

/** Presses on the checkbox must not start a drag, and must leave the focus on the row. */
export const pressProps = {
  onPointerDown: (event: PointerEvent) => event.stopPropagation(),
  onMouseDown: (event: MouseEvent) => event.preventDefault(),
}
