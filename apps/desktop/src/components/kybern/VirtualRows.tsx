import { createContext, useCallback, useContext, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react"
import { defaultRangeExtractor, elementScroll, useVirtualizer, type Range, type ReactVirtualizer } from "@tanstack/react-virtual"
import { TranscriptStateScope } from "./TranscriptStateScope"

export type VirtualRowsController = ReactVirtualizer<HTMLElement, HTMLDivElement>

interface ScrollContext {
  viewport: RefObject<HTMLElement | null>
  origin: number
}

const VirtualScrollContext = createContext<ScrollContext | null>(null)

function containingRow(node: Node | null, owner: string): HTMLElement | null {
  let element = node instanceof Element ? node : node?.parentElement
  while (element) {
    if (element instanceof HTMLElement && element.dataset.virtualOwner === owner) return element
    element = element.parentElement
  }
  return null
}

/** Dynamic rows in the transcript's existing scroller, including nested work.
 * Focus and text selections pin their rows until the interaction finishes. */
interface VirtualRowsProps<T> {
  items: readonly T[]
  getKey: (item: T, index: number) => string
  estimateSize: (item: T, index: number) => number
  children: (item: T, index: number) => ReactNode
  viewport?: RefObject<HTMLElement | null>
  controllerRef?: Ref<VirtualRowsController>
  className?: string
  anchor?: "start" | "end"
  followEnd?: boolean
}

export function VirtualRows<T>(props: VirtualRowsProps<T>) {
  if (!props.viewport && props.items.length <= 30) return <>{props.items.map((item, index) => <TranscriptStateScope key={props.getKey(item, index)} name={props.getKey(item, index)}>{props.children(item, index)}</TranscriptStateScope>)}</>
  return <VirtualizedRows {...props} />
}

function VirtualizedRows<T>({
  items,
  getKey,
  estimateSize,
  children,
  viewport: providedViewport,
  controllerRef,
  className,
  anchor,
  followEnd = true,
}: VirtualRowsProps<T>) {
  const inherited = useContext(VirtualScrollContext)
  const viewport = providedViewport ?? inherited?.viewport
  const owner = useId()
  const container = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(0)
  const [pinned, setPinned] = useState<readonly number[]>([])

  useLayoutEffect(() => {
    const list = container.current
    const scroll = viewport?.current
    if (!list || !scroll) return
    let frame = 0
    const measure = () => {
      frame = 0
      const next = list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
      setMargin((current) => Math.abs(current - next) < .5 ? current : next)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    schedule()
    const observer = new ResizeObserver(schedule)
    observer.observe(scroll)
    // Scrolling and measuring row heights do not move the list's origin in
    // scroll-content coordinates. Reading its rectangles on every scroll forced
    // layout directly after the virtualizer moved rows. Only preceding content,
    // viewport resizing, or an inherited row position can change this margin.
    for (let node: Element | null = list; node && node !== scroll; node = node.parentElement) {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) observer.observe(sibling)
    }
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [viewport, inherited?.origin, items.length])

  useLayoutEffect(() => {
    const update = () => {
      const next = new Set<number>()
      const focused = containingRow(document.activeElement, owner)
      if (focused) next.add(Number(focused.dataset.index))
      const selection = document.getSelection()
      if (selection && !selection.isCollapsed) {
        const anchor = containingRow(selection.anchorNode, owner)
        const focus = containingRow(selection.focusNode, owner)
        if (anchor && focus) {
          const a = Number(anchor.dataset.index)
          const b = Number(focus.dataset.index)
          for (let index = Math.min(a, b); index <= Math.max(a, b); index++) next.add(index)
        } else if (anchor || focus) {
          next.add(Number((anchor ?? focus)!.dataset.index))
        }
      }
      const sorted = [...next].sort((a, b) => a - b)
      setPinned((current) => current.length === sorted.length && current.every((value, index) => value === sorted[index]) ? current : sorted)
    }
    document.addEventListener("selectionchange", update)
    document.addEventListener("focusin", update)
    document.addEventListener("focusout", update)
    return () => {
      document.removeEventListener("selectionchange", update)
      document.removeEventListener("focusin", update)
      document.removeEventListener("focusout", update)
    }
  }, [owner])

  const rangeExtractor = useCallback((range: Range) => {
    if (range.count <= 30) return Array.from({ length: range.count }, (_, index) => index)
    const visible = defaultRangeExtractor(range)
    return [...new Set([...visible, ...pinned.filter((index) => index < range.count)])].sort((a, b) => a - b)
  }, [pinned])
  const getItemKey = useCallback((index: number) => getKey(items[index]!, index), [getKey, items])
  const estimate = useCallback((index: number) => estimateSize(items[index]!, index), [estimateSize, items])
  // This component reads the mutable virtualizer directly; it must not be compiler-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => viewport?.current ?? null,
    // A nested disclosure joins an already-scrolled transcript. Starting it at
    // zero would reset the shared scroll element when the disclosure mounts.
    initialOffset: () => viewport?.current?.scrollTop ?? 0,
    getItemKey,
    estimateSize: estimate,
    scrollMargin: margin,
    rangeExtractor,
    overscan: providedViewport ? 2 : 8,
    anchorTo: anchor ?? (providedViewport ? "end" : "start"),
    // End anchoring is also needed to preserve history prepends. Keep that
    // anchor, but disable automatic size-change pinning after a user gesture.
    // The library's virtual end excludes our composer's trailing overlay space,
    // so a distance threshold alone cannot tell whether the reader left it.
    scrollEndThreshold: followEnd ? 1 : -1,
    // Normal-flow rows need resize corrections before this paint. Deferring an
    // observer by a frame paints shifted content, then snaps it back.
    useAnimationFrameWithResizeObserver: false,
    // Measurements can notify from mount refs during commit. DOM-based
    // anchoring keeps flow stable without forcing a React commit per resize.
    useFlushSync: false,
    scrollToFn: (offset, options, instance) => {
      const current = instance.scrollElement?.scrollTop
      if (options.adjustments !== undefined && current !== undefined) {
        // A wheel/trackpad move can precede the scroll event that updates the
        // library's cursor. Apply height compensation to the actual position,
        // or it can undo that move. Core adds the adjustment to this cursor.
        instance.scrollOffset = current
        elementScroll(current, options, instance)
      } else {
        elementScroll(offset, options, instance)
      }
    },
  })
  const measureRow = useCallback((element: HTMLDivElement | null) => {
    virtualizer.measureElement(element)
    if (element && virtualizer.isScrolling) {
      // Core normally defers new measurements during scrolling. In normal
      // flow an overscan row's real height already affects visible neighbours;
      // account for it in this commit instead of painting the estimate first.
      virtualizer.resizeItem(Number(element.dataset.index), element.getBoundingClientRect().height)
    }
  }, [virtualizer])
  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
      const offset = instance.scrollElement?.scrollTop ?? instance.scrollOffset ?? 0
      // Compensate settled rows above the viewport in both scroll directions
      // (including late Markdown formatting). A partially visible growing row
      // should keep its top fixed rather than moving the reader with its end.
      if (!instance.itemSizeCache.has(item.key)) return item.start < offset
      // Cached starts can lag newly inserted flow siblings. Use the previous
      // DOM bottom (before this delta) so a visible row is not mistaken for an
      // offscreen row, causing a spurious correction followed by a snap back.
      const element = instance.elementsCache.get(item.key)
      const scroll = instance.scrollElement
      return element?.isConnected && scroll
        ? element.getBoundingClientRect().bottom - delta <= scroll.getBoundingClientRect().top
        : item.end <= offset
    }
    return () => { virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined }
  }, [virtualizer])
  useImperativeHandle(controllerRef, () => virtualizer, [virtualizer])
  const setContainer = useCallback((element: HTMLDivElement | null) => {
    container.current = element
  }, [])

  if (!viewport) return <>{items.map((item, index) => <TranscriptStateScope key={getKey(item, index)} name={getKey(item, index)}>{children(item, index)}</TranscriptStateScope>)}</>
  const rows = virtualizer.getVirtualItems()
  return (
    <div ref={setContainer} className={className} data-virtual-list={owner} style={{ position: "relative", width: "100%", display: "flow-root" }}>
      {/* Mounted rows share normal flow. Absolute positions based on earlier
          measurements let expanding disclosures overlap their neighbours until the
          next measurement. Spacers represent only the unmounted ranges. */}
      {rows.map((row, index) => (
        <div
          key={row.key}
          ref={measureRow}
          data-index={row.index}
          data-virtual-owner={owner}
          style={{ width: "100%", display: "flow-root", marginTop: Math.max(0, row.start - (rows[index - 1]?.end ?? margin)) }}
        >
          <VirtualScrollContext value={{ viewport, origin: row.start }}>
            <TranscriptStateScope name={String(row.key)}>{children(items[row.index]!, row.index)}</TranscriptStateScope>
          </VirtualScrollContext>
        </div>
      ))}
      <div aria-hidden style={{ height: Math.max(0, virtualizer.getTotalSize() - ((rows.at(-1)?.end ?? margin) - margin)), overflowAnchor: "none" }} />
    </div>
  )
}
