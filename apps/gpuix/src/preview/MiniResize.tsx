import type { EventPayload } from '@gpuix/react'
import { clampPlayerSize, type PlayerSize } from '../../../../packages/kybern-client/src/previewMiniPlayer.ts'
import { useWebOcclusion } from '../native/web-occlusion.ts'
import { beginPreviewResize } from './resize.tsx'
export type MiniCorner = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end'
export function MiniResize({ corner, size, bounds, onResize }: { corner: MiniCorner; size: PlayerSize; bounds?: PlayerSize; onResize(size: PlayerSize): void }) {
  const layer = useWebOcclusion('preview-mini-resize', 0, 0, true)
  const right = corner.endsWith('end'), bottom = corner.startsWith('bottom')
  const down = (event: EventPayload) => {
    if (event.x === undefined || event.y === undefined) return
    const start = { x: event.x, y: event.y }
    beginPreviewResize(event, next => {
      if (next.x === undefined || next.y === undefined) return
      onResize(clampPlayerSize({ w: size.w + (next.x - start.x) * (right ? -1 : 1), h: size.h + (next.y - start.y) * (bottom ? -1 : 1) }, bounds))
    }, right === bottom ? 'nwse-resize' : 'nesw-resize')
  }
  return <div testId={layer.id} onMouseDown={down} style={{ position: 'absolute', ...(right ? { left: 0 } : { right: 0 }), ...(bottom ? { top: 0 } : { bottom: 0 }), width: 16, height: 16, cursor: right === bottom ? 'nwse-resize' : 'nesw-resize', pointerEvents: 'auto' }} />
}
