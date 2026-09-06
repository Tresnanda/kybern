import { createContext, useCallback, useContext, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react"
import { defaultRangeExtractor, useVirtualizer, type Range, type ReactVirtualizer } from "@tanstack/react-virtual"
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
    scroll.addEventListener("scroll", schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(list)
    observer.observe(scroll)
    return () => {
      cancelAnimationFrame(frame)
      scroll.removeEventListener("scroll", schedule)
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
    anchorTo: providedViewport ? "end" : "start",
    scrollEndThreshold: 56,
    useAnimationFrameWithResizeObserver: true,
    directDomUpdates: true,
    directDomUpdatesMode: "position",
  })
  useImperativeHandle(controllerRef, () => virtualizer, [virtualizer])
  const setContainer = useCallback((element: HTMLDivElement | null) => {
    container.current = element
    virtualizer.containerRef(element)
  }, [virtualizer])

  if (!viewport) return <>{items.map((item, index) => <TranscriptStateScope key={getKey(item, index)} name={getKey(item, index)}>{children(item, index)}</TranscriptStateScope>)}</>
  return (
    <div ref={setContainer} className={className} data-virtual-list={owner} style={{ position: "relative", width: "100%" }}>
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          data-virtual-owner={owner}
          style={{ position: "absolute", left: 0, width: "100%", display: "flow-root" }}
        >
          <VirtualScrollContext value={{ viewport, origin: row.start }}>
            <TranscriptStateScope name={String(row.key)}>{children(items[row.index]!, row.index)}</TranscriptStateScope>
          </VirtualScrollContext>
        </div>
      ))}
    </div>
  )
}
