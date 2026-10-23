import { afterEach, expect, test } from 'bun:test'
import { handbackOnFocus, installFocusHandback } from './focusHandback.ts'
import { webHost } from './webview.ts'

const release = webHost.releaseFocus
afterEach(() => { webHost.releaseFocus = release })

test('focus moves release a document before GPUI moves focus, once per renderer', () => {
  const log: string[] = []
  webHost.releaseFocus = () => { log.push('release') }
  const renderer = { focusElement(id: number) { log.push(`focus ${id}`); return id }, focusNext() { log.push('next') }, flush() { log.push('flush') } }
  installFocusHandback(renderer)
  installFocusHandback(renderer)
  expect(renderer.focusElement(7)).toBe(7)
  renderer.focusNext()
  renderer.flush()
  expect(log).toEqual(['release', 'focus 7', 'release', 'next', 'flush'])
})

test('only focus events release from the root handler', () => {
  let released = 0
  webHost.releaseFocus = () => { released++ }
  handbackOnFocus({ eventType: 'mouseDown' })
  handbackOnFocus({ eventType: 'blur' })
  handbackOnFocus({ eventType: 'focus' })
  expect(released).toBe(1)
})
