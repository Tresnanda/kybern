// How many monospace characters fit across a transcript code block right now.
// Long lines opt into native soft wrap, preserving highlighting and selection.
import { useRef } from 'react'
import { dockGeometry, useDock, useDockDrag } from '../dock/store.ts'
import { usePanelOpen } from '../nav/TitleBar.tsx'
import { useSidebarDragging, useSidebarWidth, useWindowWidth } from '../shell/layout.ts'
import { MONO_ADVANCE } from '../theme.ts'
import { CODE } from './kit.tsx'

/** The 52px rail and the 8px frame inset (`App.tsx`). */
const CHROME = 52 + 8
/** The code face's advance width at the code size (Menlo on macOS, JetBrains Mono elsewhere). */
const CHAR = CODE.size * MONO_ADVANCE
/** `CodeChunk`'s 9.6px side padding (`pre { padding: .5rem .6rem }`). */
const PADDING = 19.2

/** Columns available to a code block in the chat column; Infinity before the window is measured. */
export function useCodeColumns(threadId: string | null, gutter: number, column: number, paneWidth?: number): number {
  const windowWidth = useWindowWidth()
  const sidebarWidth = useSidebarWidth()
  const panelOpen = usePanelOpen()
  const dock = useDock(threadId)
  const resizing = useSidebarDragging() || !!useDockDrag()
  const last = useRef(Infinity)
  // Hold the value while a panel is dragged, so a drag never rebuilds the transcript's rows.
  if (resizing || !windowWidth) return last.current
  const panel = panelOpen ? sidebarWidth : 0
  const geometry = dockGeometry(windowWidth, panel, dock.width)
  const dockWidth = dock.open && !geometry.overlay ? geometry.width : 0
  const content = paneWidth ?? windowWidth - CHROME - panel - dockWidth
  const width = Math.min(column, content - 2 * gutter) - PADDING
  last.current = Math.max(20, Math.floor(width / CHAR))
  return last.current
}

/** The longest line, in characters (tabs count as two, as the code font renders them). */
export function longestLine(text: string): number {
  let longest = 0
  for (const line of text.split('\n')) longest = Math.max(longest, line.replace(/\t/g, '  ').length)
  return longest
}
