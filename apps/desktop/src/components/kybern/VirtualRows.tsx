import { createContext, useCallback, useContext, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react"
import { defaultRangeExtractor, elementScroll, useVirtualizer, type Range, type ReactVirtualizer } from "@tanstack/react-virtual"
import { reconcileVirtualTopology, type VirtualTopology } from "@/lib/virtualTopology"
import { recordScrollPosition } from "@/lib/scrollPosition"
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
  if (!props.viewport && props.items.length <= 30) return <PlainRows {...props} />
  return <VirtualizedRows {...props} />
}

/** Short lists stay in normal flow, but each item is still its own paint host:
 * one tall item (an opened tool group) would otherwise make the enclosing
 * work container a tiled layer that paints its siblings and accumulates
 * scroll tiles. Margins collapse through the wrapper, so spacing is unchanged. */
function PlainRows<T>({ items, getKey, children }: VirtualRowsProps<T>) {
  return <>{items.map((item, index) => {
    const key = getKey(item, index)
    return <div key={key} className="chat-paint-host" data-virtual-key={key}><TranscriptStateScope name={key}>{children(item, index)}</TranscriptStateScope></div>
  })}</>
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
  const measuredMargin = useRef<number | null>(null)
  const [pinned, setPinned] = useState<{ focused: string | null; selection: readonly [string, string] | null }>({ focused: null, selection: null })

  useLayoutEffect(() => {
    const list = container.current
    const scroll = viewport?.current
    if (!list || !scroll) return
    let frame = 0
    const measure = () => {
      frame = 0
      const next = list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
      const previous = measuredMargin.current
      measuredMargin.current = next
      // A top-level history status can disappear once paging is exhausted.
      // Preserve the reader below it while the list's content origin changes.
      if (providedViewport && !followEnd && previous !== null && Math.abs(next - previous) >= .5 && scroll.scrollTop > Math.max(previous, next)) {
        scroll.scrollTop += next - previous
        recordScrollPosition(scroll)
      }
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
  }, [viewport, providedViewport, followEnd, inherited?.origin, items.length])

  useLayoutEffect(() => {
    const update = () => {
      const focused = containingRow(document.activeElement, owner)?.dataset.virtualKey ?? null
      const selection = document.getSelection()
      let endpoints: readonly [string, string] | null = null
      if (selection && !selection.isCollapsed) {
        const anchor = containingRow(selection.anchorNode, owner)?.dataset.virtualKey
        const focus = containingRow(selection.focusNode, owner)?.dataset.virtualKey
        if (anchor || focus) endpoints = [anchor ?? focus!, focus ?? anchor!]
      }
      setPinned(current => current.focused === focused && current.selection?.[0] === endpoints?.[0] && current.selection?.[1] === endpoints?.[1]
        ? current : { focused, selection: endpoints })
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
    // Array positions change on prepend/eviction. Resolve interaction pins from
    // stable row keys before rendering so focused/selected DOM never drops out.
    const indexOf = (key: string | null) => key === null ? -1 : items.findIndex((item, index) => String(getKey(item, index)) === key)
    const indices = new Set(visible)
    // WebKit queues selectionchange. A store update can render a new topology
    // before that notification, so also pin the live DOM endpoints before any
    // rows are removed. The subscribed pins still invalidate a settled range
    // when selection/focus changes without a transcript update.
    const focused = indexOf(containingRow(document.activeElement, owner)?.dataset.virtualKey ?? pinned.focused)
    if (focused >= 0) indices.add(focused)
    const selection = document.getSelection()
    const anchor = selection && !selection.isCollapsed ? containingRow(selection.anchorNode, owner)?.dataset.virtualKey : undefined
    const focus = selection && !selection.isCollapsed ? containingRow(selection.focusNode, owner)?.dataset.virtualKey : undefined
    const endpoints = anchor || focus ? [anchor ?? focus!, focus ?? anchor!] : pinned.selection
    if (endpoints) {
      const a = indexOf(endpoints[0]!), b = indexOf(endpoints[1]!)
      if (a >= 0 && b >= 0) for (let index = Math.min(a, b); index <= Math.max(a, b); index++) indices.add(index)
      else if (a >= 0 || b >= 0) indices.add(Math.max(a, b))
    }
    return [...indices].sort((a, b) => a - b)
  }, [pinned, items, getKey, owner])
  // TanStack Virtual treats getItemKey identity as measurement topology. An
  // immutable streaming update used to replace this callback every render and
  // rebuild every measurement even when all row keys and estimates were
  // unchanged. State provides a concurrency-safe prior snapshot; unlike a ref,
  // it is never mutated during render. React immediately retries the uncommon
  // topology-changing render before committing its children.
  const [previousTopology, setPreviousTopology] = useState<VirtualTopology>(() =>
    reconcileVirtualTopology(null, items, getKey, estimateSize),
  )
  const topology = reconcileVirtualTopology(previousTopology, items, getKey, estimateSize)
  if (topology !== previousTopology) setPreviousTopology(topology)
  const getItemKey = useCallback((index: number) => topology.keys[index]!, [topology])
  const estimate = useCallback((index: number) => topology.estimates[index]!, [topology])
  const committedTopology = useRef(topology)
  const isRebasing = useCallback((instance: Pick<VirtualRowsController, "options">) => {
    const keys = committedTopology.current.keys
    const { count, getItemKey } = instance.options
    return count !== keys.length || (count > 0 && (getItemKey(0) !== keys[0] || getItemKey(count - 1) !== keys.at(-1)))
  }, [])
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
      if (options.adjustments !== undefined && current !== undefined && !isRebasing(instance)) {
        // A wheel/trackpad move can precede the scroll event that updates the
        // library's cursor. Apply height compensation to the actual position,
        // or it can undo that move. Core adds the adjustment to this cursor.
        // During prepend/trim, core has already rebased its cursor
        // before DOM commit. Retain that intended offset until its layout effect
        // applies it; the DOM still contains the old scroll position here.
        instance.scrollOffset = current
        elementScroll(current, options, instance)
      } else {
        elementScroll(offset, options, instance)
      }
      recordScrollPosition(instance.scrollElement)
    },
  })
  const measureRow = useCallback((element: HTMLDivElement | null) => {
    virtualizer.measureElement(element)
    if (element && virtualizer.isScrolling) {
      // Core normally defers new measurements during scrolling. In normal
      // flow an overscan row's real height already affects visible neighbours;
      // account for it in this commit instead of painting the estimate first.
      // Match core's rounded border-box measurements. Mixing fractional mount
      // sizes with rounded observer sizes repeatedly corrects the same row.
      virtualizer.resizeItem(Number(element.dataset.index), Math.round(element.getBoundingClientRect().height))
    }
  }, [virtualizer])
  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
      const rebasing = isRebasing(instance)
      const offset = rebasing ? instance.scrollOffset ?? 0 : instance.scrollElement?.scrollTop ?? instance.scrollOffset ?? 0
      // Compensate settled rows above the viewport in both scroll directions
      // (including late Markdown formatting). A partially visible growing row
      // should keep its top fixed rather than moving the reader with its end.
      if (!instance.itemSizeCache.has(item.key)) return item.start < offset
      if (rebasing) return item.end <= offset
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
  }, [virtualizer, isRebasing])
  useLayoutEffect(() => { committedTopology.current = topology }, [topology])
  useImperativeHandle(controllerRef, () => virtualizer, [virtualizer])
  const setContainer = useCallback((element: HTMLDivElement | null) => {
    container.current = element
  }, [])

  if (!viewport) return <PlainRows items={items} getKey={getKey} estimateSize={estimateSize}>{children}</PlainRows>
  const rows = virtualizer.getVirtualItems()
  return (
    <div ref={setContainer} className={className} data-virtual-list={owner} style={{ position: "relative", width: "100%", display: "flow-root" }}>
      {/* Mounted rows share normal flow. Absolute positions based on earlier
          measurements let expanding disclosures overlap their neighbours until the
          next measurement. Spacers represent only the unmounted ranges. */}
      {rows.map((row, index) => {
        const content = (
          <VirtualScrollContext value={{ viewport, origin: row.start }}>
            <TranscriptStateScope name={String(row.key)}>{children(items[row.index]!, row.index)}</TranscriptStateScope>
          </VirtualScrollContext>
        )
        return (
          <div
            key={row.key}
            ref={measureRow}
            data-index={row.index}
            data-virtual-key={String(row.key)}
            data-virtual-owner={owner}
            style={{ width: "100%", display: "flow-root", willChange: "transform", marginTop: Math.max(0, row.start - (rows[index - 1]?.end ?? margin)) }}
          >
            {/* Each mounted row is its own compositing layer (see .chat-paint-host
                in kit.css): its backing store is bounded by the row, and the
                scroller's tiled layer has nothing left to paint, so WebKit stops
                accumulating scroll tiles. The outer paint boundary additionally
                clips large history rows; its 8px bleed preserves focus rings,
                negative icon margins and entry motion without changing row
                measurements or gutters. */}
            {providedViewport ? <div style={{ contain: items.length > 30 ? "paint" : undefined, margin: -8, padding: 8 }}>{content}</div> : content}
          </div>
        )
      })}
      <div aria-hidden style={{ height: Math.max(0, virtualizer.getTotalSize() - ((rows.at(-1)?.end ?? margin) - margin)), overflowAnchor: "none" }} />
    </div>
  )
}
