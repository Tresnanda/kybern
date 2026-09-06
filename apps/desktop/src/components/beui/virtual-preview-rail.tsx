import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual"
import type { PreviewRailItem } from "./preview-rail"
import { cn } from "@/lib/utils"

/** Long rails scroll independently instead of mounting hundreds of clipped ticks. */
export function VirtualPreviewRail({ items, label, activeId, itemSize, onSelect, renderPreview, showPreview, rootRef, railClassName, previewContainerClassName, previewClassName }: {
  items: readonly PreviewRailItem[]
  label: string
  activeId: string
  itemSize: number
  onSelect: (item: PreviewRailItem) => void
  renderPreview: (item: PreviewRailItem) => ReactNode
  showPreview: boolean
  rootRef: RefObject<HTMLDivElement | null>
  railClassName?: string
  previewContainerClassName?: string
  previewClassName?: string
}) {
  const nav = useRef<HTMLElement>(null)
  const focusFrame = useRef(0)
  useLayoutEffect(() => () => cancelAnimationFrame(focusFrame.current), [])
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [previewTop, setPreviewTop] = useState(0)
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === activeId))
  const focusedIndex = items.findIndex((item) => item.id === focused)
  const displayedIndex = items.findIndex((item) => item.id === (hovered ?? focused))
  const highlighted = displayedIndex >= 0 ? displayedIndex : activeIndex
  const rangeExtractor = useCallback((range: Range) => {
    const indices = defaultRangeExtractor(range)
    return focusedIndex < 0 ? indices : [...new Set([...indices, focusedIndex])].sort((a, b) => a - b)
  }, [focusedIndex])
  const getItemKey = useCallback((index: number) => items[index]!.id, [items])
  // The virtualizer is intentionally read imperatively; this component is not compiler-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer<HTMLElement, HTMLButtonElement>({
    count: items.length,
    getScrollElement: () => nav.current,
    getItemKey,
    estimateSize: () => itemSize,
    rangeExtractor,
    overscan: 4,
  })
  useLayoutEffect(() => {
    const element = nav.current
    if (element && !hovered && !focused) element.scrollTop = Math.max(0, activeIndex * itemSize - (element.clientHeight - itemSize) / 2)
  }, [activeIndex, hovered, focused, itemSize])

  const positionPreview = (element: HTMLElement) => {
    const root = rootRef.current
    if (!root) return
    const center = element.getBoundingClientRect().top + itemSize / 2 - root.getBoundingClientRect().top
    setPreviewTop(Math.max(12, Math.min(root.clientHeight - 92, center - 40)))
  }

  return <>
    <nav
      ref={nav}
      aria-label={label}
      data-virtual-rail="true"
      className={cn("relative z-10 w-12 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", railClassName, "content-start")}
      onPointerLeave={(event) => { if (event.pointerType !== "touch") setHovered(null) }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null) }}
      onKeyDown={(event) => {
        const current = Number((event.target as HTMLElement).closest<HTMLElement>("[data-rail-index]")?.dataset.railIndex ?? activeIndex)
        const next = event.key === "ArrowDown" ? current + 1 : event.key === "ArrowUp" ? current - 1
          : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : event.key === "PageDown" ? current + 10 : event.key === "PageUp" ? current - 10 : null
        if (next === null) return
        event.preventDefault()
        cancelAnimationFrame(focusFrame.current)
        const index = Math.max(0, Math.min(items.length - 1, next))
        setFocused(items[index]!.id)
        const element = event.currentTarget
        const top = index * itemSize
        if (top < element.scrollTop) element.scrollTop = top
        else if (top + itemSize > element.scrollTop + element.clientHeight) element.scrollTop = top + itemSize - element.clientHeight
        let tries = 0
        const focus = () => {
          const button = nav.current?.querySelector<HTMLButtonElement>(`[data-rail-index="${index}"]`)
          if (!button && tries++ < 5) { focusFrame.current = requestAnimationFrame(focus); return }
          button?.focus({ preventScroll: true })
          if (button) positionPreview(button)
        }
        focusFrame.current = requestAnimationFrame(focus)
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]!
          const distance = Math.abs(row.index - highlighted)
          const scale = distance === 0 ? 1 : distance === 1 ? .68 : distance === 2 ? .44 : .25
          return <button
            key={item.id}
            type="button"
            data-slot="preview-rail-item"
            data-rail-index={row.index}
            aria-label={item.ariaLabel ?? String(item.label)}
            aria-current={item.id === activeId ? "page" : undefined}
            style={{ position: "absolute", top: row.start, left: 0, height: row.size }}
            className="flex w-12 items-center text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onPointerEnter={(event) => {
              if (event.pointerType === "touch" || event.buttons) return
              setHovered(item.id); positionPreview(event.currentTarget)
            }}
            onFocus={(event) => {
              if (!event.currentTarget.matches(":focus-visible")) return
              setFocused(item.id); positionPreview(event.currentTarget)
            }}
            onClick={() => onSelect(item)}
          >
            <span data-slot="preview-rail-tick" aria-hidden="true" className={cn("block h-0.5 w-12 origin-left bg-current transition-transform duration-150 ease-out motion-reduce:transition-none", distance === 0 && "text-foreground")} style={{ transform: `scaleX(${scale})` }} />
          </button>
        })}
      </div>
    </nav>
    {showPreview && displayedIndex >= 0 && <div className={cn("pointer-events-none absolute z-50", previewContainerClassName)} style={{ top: previewTop }}>
      <div className={previewClassName}>{renderPreview(items[displayedIndex]!)}</div>
    </div>}
  </>
}
