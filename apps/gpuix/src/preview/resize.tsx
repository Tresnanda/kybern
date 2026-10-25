import { useEffect, useSyncExternalStore } from 'react'
import type { EventPayload } from '@gpuix/react'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { watchPointerRelease } from '../split/release.ts'
import { cls, getObjc, nsApp, sel } from '../native/objc.ts'
import { webHost } from '../native/webview.ts'
import { onEnvironmentLeaving } from '../shell/environment.ts'

let drag: { move(event: EventPayload): void; cursor: 'col-resize' | 'row-resize' | 'nwse-resize' | 'nesw-resize' } | null = null
const listeners = new Set<() => void>()
let stopRelease: (() => void) | undefined, releaseInput: (() => void) | undefined
function end() { stopRelease?.(); stopRelease = undefined; releaseInput?.(); releaseInput = undefined; drag = null; for (const listener of listeners) listener() }
export function beginPreviewResize(event: EventPayload, move: (event: EventPayload) => void, cursor: NonNullable<typeof drag>['cursor']) {
  if (event.button !== 0 || event.x === undefined || event.y === undefined) return
  end(); drag = { move, cursor }; releaseInput = webHost.capturePointer()
  // AppKit's pressed-button state is the macOS backstop for a release that never reaches the capture layer. Elsewhere the layer
  // itself ends the drag: it covers the window, so a mouse-up lands on it, and any move reporting no pressed button cancels.
  if (process.platform === 'darwin') {
    const o = getObjc(), app = nsApp()
    stopRelease = watchPointerRelease(() => ({ pressed: (Number(o.msgU64(cls(o, 'NSEvent'), sel(o, 'pressedMouseButtons'))) & 1) !== 0, active: !!app && !!o.msgU64(app, sel(o, 'isActive')) }), end)
  }
  for (const listener of listeners) listener()
}
/** Mounted beside the dock, covering the whole workspace only during a resize.
 * The native input lease leaves pages painted while GPUI owns the gesture. */
export function PreviewResizeCapture() {
  const current = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => drag)
  useEffect(() => addWindowKeyHandler(event => { if (event.key === 'escape' && drag) { end(); return true } }), [])
  useEffect(() => () => end(), [])
  if (!current) return null
  const move = (event: EventPayload) => { if (event.pressedButton !== 0) { end(); return } current.move(event) }
  return <div testId="preview-resize-capture" onMouseMove={move} onMouseUp={event => { current.move(event); end() }} onMouseDownOutside={end} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', cursor: current.cursor, userSelect: 'none', pointerEvents: 'auto' }} />
}
onEnvironmentLeaving(end)
