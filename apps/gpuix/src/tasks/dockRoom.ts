// How much of a page's foot a floating dock takes (`DockShell`). Kept apart from the shell so it can be tested without a renderer.

/**
 * How far the page's content stops short of its foot for a dock `height` tall: whole-window glass has no colour to hide rows behind
 * the dock with, so the list ends at the dock's top; elsewhere rows pass under the band and a spacer of `spacer` clears the last one.
 */
export function dockRoom(glass: boolean, height: number): { inset: number; spacer: number } {
  return glass ? { inset: height, spacer: 0 } : { inset: 0, spacer: height + 12 }
}
