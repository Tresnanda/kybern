import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { ReactNode } from 'react'

mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => true, onWindowVisibility: () => () => {} }))
const { AttachmentLightbox } = await import('./Lightbox.tsx')
const { ThemeProvider } = await import('../ui.tsx')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
const { handleGpuixEvent } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/event-registry.js')).href)

// Review 2026-10-21: Tab left the open preview for the window behind it.
test('Tab and Shift-Tab wrap inside the open preview', () => {
  const custom = new Map<number, Record<string, any>>(), moves: string[] = []
  const renderer = {
    applyBatch(json: string) {
      for (const [op, id, a, b] of JSON.parse(json) as [string, number, any, any][]) {
        if (op === 'createElement') custom.set(id, {})
        else if (op === 'setCustomProp') custom.get(id)![a] = b
      }
      return []
    },
    setWindowKeyEvents() {}, setWindowSelectionChange() {},
    addLayoutObserver: () => 1, removeLayoutObserver() {}, isLayoutObserverActive: () => true,
    getWindowSize: () => ({ width: 1200, height: 800 }),
    focusNextWithin: (id: number) => moves.push(`next:${id}`),
    focusPreviousWithin: (id: number) => moves.push(`previous:${id}`),
  }
  const root = createRoot(renderer)
  const image = new URL('../../../desktop/src-tauri/icons/128x128@2x.png', import.meta.url).pathname
  const render = (node: ReactNode) => flushSync(() => root.render(node))
  render(<ThemeProvider><AttachmentLightbox source={image} label="icon.png" from={null} tile={() => null} onClose={() => {}} /></ThemeProvider>)
  const box = [...custom].find(([, props]) => props.testId === 'attachment-lightbox')![0]
  const fire = (payload: Record<string, unknown>) => flushSync(() => handleGpuixEvent({ elementId: box, eventType: 'keyDown', ...payload }, renderer))
  fire({ key: 'tab', modifiers: {} })
  fire({ key: 'tab', modifiers: { shift: true } })
  expect(moves).toEqual([`next:${box}`, `previous:${box}`])
  root.unmount()
})
