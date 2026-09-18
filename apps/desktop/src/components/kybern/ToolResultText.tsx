import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent } from "react"
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual"
import { estimateToolResultRow, splitToolResultRows, toolResultCopyText, toolResultRowText } from "@/lib/toolResultText"

/** Open tool-result text in the existing max-h-72 scroller. Offscreen lines
 * unmount; on-screen text and clipboard copy stay exact. This is not
 * `VirtualRows`: no paint hosts, `will-change`, or `contain: paint`. */

function rowIndex(node: Node | null, owner: HTMLElement): number | null {
  let element = node instanceof Element ? node : node?.parentElement
  while (element && element !== owner) {
    if (element instanceof HTMLElement && element.dataset.index != null) {
      const index = Number(element.dataset.index)
      return Number.isInteger(index) ? index : null
    }
    element = element.parentElement
  }
  return null
}

function selectedRange(owner: HTMLElement): readonly [number, number] | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed) return null
  const anchor = rowIndex(selection.anchorNode, owner)
  const focus = rowIndex(selection.focusNode, owner)
  if (anchor == null && focus == null) return null
  const start = Math.min(anchor ?? focus!, focus ?? anchor!)
  const end = Math.max(anchor ?? focus!, focus ?? anchor!)
  return [start, end]
}

function selectionCoversScroller(owner: HTMLElement): boolean {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  if (!owner.contains(range.commonAncestorContainer)) return false
  const contents = document.createRange()
  contents.selectNodeContents(owner)
  return range.compareBoundaryPoints(Range.START_TO_START, contents) <= 0
    && range.compareBoundaryPoints(Range.END_TO_END, contents) >= 0
}

export function ToolResultText({ text, className }: { text: string; className?: string }) {
  const viewport = useRef<HTMLPreElement>(null)
  const rows = useMemo(() => splitToolResultRows(text), [text])
  const [pinned, setPinned] = useState<readonly [number, number] | null>(null)

  useLayoutEffect(() => {
    if (!rows) return
    const owner = viewport.current
    if (!owner) return
    const update = () => {
      const next = selectedRange(owner)
      setPinned((current) => current?.[0] === next?.[0] && current?.[1] === next?.[1] ? current : next)
    }
    document.addEventListener("selectionchange", update)
    return () => document.removeEventListener("selectionchange", update)
  }, [rows])

  const rangeExtractor = useCallback((range: Range) => {
    const visible = defaultRangeExtractor(range)
    const owner = viewport.current
    const live = owner ? selectedRange(owner) : null
    const span = live ?? pinned
    if (!span) return visible
    const indices = new Set(visible)
    for (let index = span[0]; index <= span[1]; index++) {
      if (index >= 0 && index < range.count) indices.add(index)
    }
    return [...indices].sort((left, right) => left - right)
  }, [pinned])
  const getItemKey = useCallback((index: number) => index, [])
  const estimateSize = useCallback((index: number) => rows ? estimateToolResultRow(rows[index]!) : 22, [rows])

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows?.length ?? 0,
    getScrollElement: () => viewport.current,
    estimateSize,
    overscan: 4,
    rangeExtractor,
    getItemKey,
    enabled: rows != null,
    useAnimationFrameWithResizeObserver: false,
    useFlushSync: false,
  })

  const onCopy = (event: ClipboardEvent<HTMLPreElement>) => {
    if (!rows || !event.clipboardData) return
    const owner = event.currentTarget
    if (selectionCoversScroller(owner)) {
      event.preventDefault()
      event.clipboardData.setData("text/plain", text)
      return
    }
    const selected = document.getSelection()?.toString() ?? ""
    const next = toolResultCopyText(text, owner.textContent ?? "", selected)
    if (next === selected) return
    event.preventDefault()
    event.clipboardData.setData("text/plain", next)
  }

  return (
    <pre
      ref={viewport}
      className={className}
      data-tool-result-chars={text.length}
      data-tool-result-virtual={rows ? "" : undefined}
      onCopy={onCopy}
    >{rows ? (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%", overflowAnchor: "none" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-tool-result-row=""
                style={{ position: "absolute", top: item.start, left: 0, width: "100%", minHeight: "1lh" }}
              >{toolResultRowText(text, row)}</div>
            )
          })}
        </div>
      ) : text}</pre>
  )
}
