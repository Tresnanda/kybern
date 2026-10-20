// The desktop pane (`views/Terminal.tsx`) is `px-3 pt-1 pb-2` around the xterm host, `.xterm` adds
// `padding: 10px 12px` (`styles/kybern.css`), and @xterm/addon-fit 0.11 sizes the grid as
// floor((parseInt(host) - padding - scrollbar) / cell) with a 14px scrollbar reserved while scrollback is on.
export const PANE_X = 12, PANE_TOP = 4, PANE_BOTTOM = 8
export const XTERM_X = 12, XTERM_Y = 10, SCROLLBAR = 14

/**
 * Columns and rows xterm.js picks for a pane of this size (the pane box, padding included). The desktop's host is a
 * whole number of pixels (parseInt); GPUIX layout lands a fraction off it (537.8 for the desktop's 538), so round.
 */
export function fitTerminal(width: number, height: number, cell: number, row: number) {
  const host = { width: Math.max(0, Math.round(width - PANE_X * 2)), height: Math.round(height - PANE_TOP - PANE_BOTTOM) }
  return {
    cols: Math.max(2, Math.floor((host.width - XTERM_X * 2 - SCROLLBAR) / cell)),
    rows: Math.max(1, Math.floor((host.height - XTERM_Y * 2) / row)),
  }
}
