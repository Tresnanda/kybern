import { useState } from 'react'
import type { EventPayload } from '@gpuix/react'
import { fitAxis, resizeViewport, viewportLayout, type ResizeEdge } from '../../../../packages/kybern-client/src/previewViewport.ts'
import { usePreview, setPreview } from './store.ts'
import { beginPreviewResize } from './resize.tsx'
import { useTheme } from '../ui.tsx'

export function DeviceRails({ threadId, width, height }: { threadId: string; width: number; height: number }) {
  const s = usePreview(threadId), t = useTheme(), [hover, setHover] = useState<ResizeEdge | null>(null)
  if (!s.device || width <= 0 || height <= 0) return null
  const layout = viewportLayout({ w: s.width, h: s.height }, { w: width, h: height })
  const down = (edge: ResizeEdge, event: EventPayload) => {
    if (event.x === undefined || event.y === undefined) return
    const start = { w: s.width, h: s.height }, startPointer = { x: event.x, y: event.y }
    beginPreviewResize(event, next => {
      if (next.x === undefined || next.y === undefined) return
      const size = resizeViewport({ edge, start, startPointer, pointer: { x: next.x, y: next.y }, scale: layout.scale, shift: next.modifiers?.shift })
      setPreview(threadId, { width: size.w, height: size.h, preset: null })
    }, edge === 'e' ? 'col-resize' : edge === 's' ? 'row-resize' : 'nwse-resize')
  }
  const fit = (edge: ResizeEdge) => {
    let size = { w: s.width, h: s.height }
    if (edge !== 's') size = fitAxis('w', size, { w: width, h: height })
    if (edge !== 'e') size = fitAxis('h', size, { w: width, h: height })
    setPreview(threadId, { width: size.w, height: size.h, preset: null })
  }
  return <>{(['e','s','se'] as const).map(edge => <div key={edge} testId={`preview-rail-${edge}`} onMouseDown={event => { if ((event.clickCount ?? 1) >= 2) fit(edge); else down(edge,event) }} onMouseEnter={() => setHover(edge)} onMouseLeave={() => setHover(null)} style={{ position: 'absolute', left: layout.left + (edge === 's' ? 0 : layout.width), top: layout.top + (edge === 'e' ? 0 : layout.height), width: edge === 's' ? layout.width : 10, height: edge === 'e' ? layout.height : 10, cursor: edge === 'e' ? 'col-resize' : edge === 's' ? 'row-resize' : 'nwse-resize' }}>
    {hover === edge && <div style={{ position: 'absolute', ...(edge === 'e' ? { top: layout.height / 2 - 14, left: 3, width: 4, height: 28 } : edge === 's' ? { left: layout.width / 2 - 14, top: 3, width: 28, height: 4 } : { left: 3, top: 3, width: 4, height: 4 }), borderRadius: 2, backgroundColor: t.borderHeavy, pointerEvents: 'none' }} />}
  </div>)}</>
}
