// The transcript's message rail: BeUI's message scroller rail as the desktop mounts it
// (`components/beui/message-scroller.tsx`, `preview-rail.tsx`, `views/Transcript.tsx:480`).
//
// Geometry (measured in the desktop at 1280×820): a 28px column 20px from the pane's left edge,
// running from 12px below the pane top to `bottomInset + 24` above its bottom and centring its
// rows in that box; one 28×14 row per user prompt with a 1px tick, 16px wide for the highlighted
// prompt and 0.68 / 0.44 / 0.25 of that at distance 1 / 2 / more. The highlighted prompt is the
// hovered one, else the one at the reader's position. Ticks resize on `SPRING_LAYOUT`
// (stiffness 360, damping 32, mass .6), which the native spring reproduces as `RAIL_SPRING`.
//
// The hover card is 256×80 at x = 60 (`left-14` + `ml-1`), radius 18, 12px padding, a one-line
// title and a two-line description. It appears at once, glides between rows on the same spring
// and disappears at once. Its row grid is centred on the whole pane rather than on the rail
// box, so the card sits `(bottomInset + 12) / 2` lower than its tick, exactly as the desktop's
// does (`previewContainerClassName` has no inset of its own).
//
// A rail with more rows than fit shows a window centred on the active prompt, like the
// desktop's virtual rail does with its scroll position.
import { motion } from '@gpuix/react'
import { memo, useMemo, useState } from 'react'
import { REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Para } from './kit.tsx'

export interface RailItem { id: string; label: string; description?: string }

const ROW = 14
const COLUMN_LEFT = 20
const COLUMN_WIDTH = 28
const TICK = 16
const CARD = { left: 60, width: 256, height: 80 }
/** `SPRING_LAYOUT` (stiffness 360, damping 32, mass 0.6) fitted to the desktop's frames: settles in 0.54 s, no overshoot. */
const RAIL_SPRING = () => REDUCED_MOTION ? { duration: 0 } : { type: 'spring' as const, duration: 0.54, bounce: 0 }

const scale = (distance: number) => (distance === 0 ? 1 : distance === 1 ? 0.68 : distance === 2 ? 0.44 : 0.25)

export const MessageRail = memo(function MessageRail({ items, active, height, bottomInset, onJump }: {
  items: readonly RailItem[]
  active: string | null
  /** The transcript pane's height. */
  height: number
  /** Space under the transcript taken by the floating composer (`bottomInset`). */
  bottomInset: number
  onJump: (id: string) => void
}) {
  const t = useTheme()
  const [hovered, setHovered] = useState<string | null>(null)
  const railHeight = Math.max(0, height - 12 - (bottomInset + 24))
  const capacity = Math.max(1, Math.floor((railHeight - 8) / ROW))
  const activeIndex = Math.max(0, items.findIndex(item => item.id === active))
  const first = items.length <= capacity ? 0 : Math.min(items.length - capacity, Math.max(0, activeIndex - Math.floor(capacity / 2)))
  const rows = useMemo(() => items.slice(first, first + capacity), [items, first, capacity])
  if (items.length < 2 || height <= 0) return null
  const highlighted = hovered ?? active ?? items[0]!.id
  const highlightedRow = rows.findIndex(item => item.id === highlighted)
  const hoveredRow = hovered ? rows.findIndex(item => item.id === hovered) : -1
  // The card's row grid is centred on the whole pane (see the header).
  const cardTop = hoveredRow < 0 ? 0 : Math.max(12, Math.min(height - CARD.height - 12, height / 2 - (rows.length * ROW) / 2 + hoveredRow * ROW + ROW / 2 - CARD.height / 2))
  const hoveredItem = hoveredRow < 0 ? null : rows[hoveredRow]!
  return <>
    <div
      testId="message-rail"
      onMouseLeave={() => setHovered(null)}
      style={{ position: 'absolute', left: COLUMN_LEFT, top: 12, width: COLUMN_WIDTH, height: railHeight, display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}
    >
      {rows.map((item, index) => {
        const lit = index === highlightedRow
        return <div
          key={item.id}
          testId={`message-jump-${first + index}`}
          role="button"
          aria-label={item.label}
          onMouseEnter={() => setHovered(item.id)}
          onClick={() => onJump(item.id)}
          style={{ display: 'flex', alignItems: 'center', flexShrink: 0, width: COLUMN_WIDTH, height: ROW, cursor: 'pointer' }}
        >
          <motion.div
            initial={{ width: TICK * scale(highlightedRow < 0 ? 9 : Math.abs(index - highlightedRow)) }}
            animate={{ width: TICK * scale(highlightedRow < 0 ? 9 : Math.abs(index - highlightedRow)) }}
            transition={RAIL_SPRING()}
            style={{ height: 1, backgroundColor: lit ? t.text : t.v('--muted-foreground'), pointerEvents: 'none' }}
          />
        </div>
      })}
    </div>
    {hoveredItem && <motion.div
      key="card"
      testId="message-preview"
      initial={{ top: cardTop }}
      animate={{ top: cardTop }}
      transition={RAIL_SPRING()}
      style={{ position: 'absolute', left: CARD.left, width: CARD.width, height: CARD.height, display: 'flex', flexDirection: 'column', gap: 4, padding: 12, borderRadius: 18, borderWidth: 1, borderColor: t.v('--border'), backgroundColor: t.v('--card'), overflow: 'hidden', pointerEvents: 'none', boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 3, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.1)' } }}
    >
      <Para color={t.v('--card-foreground')} size={12} lineHeight={16} weight={500} style={{ lineClamp: 1 }}>{hoveredItem.label}</Para>
      {hoveredItem.description && <Para color={t.v('--muted-foreground')} size={12} lineHeight={16} style={{ lineClamp: 2 }}>{hoveredItem.description}</Para>}
    </motion.div>}
  </>
})
