// One pill that slides behind the active tab of a segmented row (`.t-tabs` +
// `.t-tabs-pill`, `useSlidingPill`): transform/width over `--duration-fast`
// smooth-out, none under Reduce Motion; the first measurement lands in place.
// The row and the active tab are measured with post-paint layout observers.
import { motion, useGpuixRequired, type PublicInstance, type StyleDesc } from '@gpuix/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { observeElementBounds } from '../native/layout.ts'
import { DURATION, EASE } from '../motion/kit.tsx'
import { REDUCED_MOTION } from '../ui.tsx'

export function useSlidingPill(active: string, count: number) {
  const renderer = useGpuixRequired()
  const [row, setRow] = useState<PublicInstance | null>(null)
  const nodes = useRef(new Map<string, PublicInstance | null>())
  const [activeNode, setActiveNode] = useState<PublicInstance | null>(null)
  const [pill, setPill] = useState<{ x: number; width: number } | null>(null)
  const rects = useRef<{ row?: { x: number }; chip?: { x: number; width: number } }>({})
  useEffect(() => setActiveNode(nodes.current.get(active) ?? null), [active, row, count])
  useEffect(() => {
    if (!row || !activeNode) return
    const place = () => {
      const { row: r, chip } = rects.current
      if (r && chip) setPill(previous => previous && previous.x === chip.x - r.x && previous.width === chip.width ? previous : { x: chip.x - r.x, width: chip.width })
    }
    const stops = [
      observeElementBounds(renderer, row.id, event => { if (event.rect) { rects.current.row = event.rect; place() } }),
      observeElementBounds(renderer, activeNode.id, event => { if (event.rect) { rects.current.chip = event.rect; place() } }),
    ]
    return () => stops.forEach(stop => stop())
  }, [renderer, row, activeNode])
  const tab = useCallback((key: string) => (node: PublicInstance | null) => { nodes.current.set(key, node) }, [])
  return { rowRef: setRow, tab, pill }
}

export function Pill({ pill, top = 0, height, style }: { pill: { x: number; width: number } | null; top?: number; height: number; style: StyleDesc }) {
  if (!pill) return null
  return <motion.div
    testId="sliding-pill"
    initial={{ left: pill.x, width: pill.width }}
    animate={{ left: pill.x, width: pill.width }}
    transition={REDUCED_MOTION ? { duration: 0 } : { duration: DURATION.fast, ease: [...EASE.smoothOut] }}
    style={{ position: 'absolute', top, height, pointerEvents: 'none', ...style }}
  />
}
