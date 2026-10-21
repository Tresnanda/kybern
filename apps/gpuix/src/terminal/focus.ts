// Whether any terminal holds keyboard focus. Window shortcuts that collide with terminal
// input (⌃1–⌃9 are control bytes for the PTY) stand down while one does.
let focused = 0

/** A terminal gained (`true`) or lost (`false`) focus. Callers pair them. */
export function noteTerminalFocus(gained: boolean) {
  focused = Math.max(0, focused + (gained ? 1 : -1))
}

export const terminalHasFocus = () => focused > 0
