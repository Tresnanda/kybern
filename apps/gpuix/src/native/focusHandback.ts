import { webHost } from './webview.ts'

// A document that was clicked keeps AppKit's first responder while GPUI moves its own focus, so the composer shows a
// caret and every key goes to the page (and beeps). `webview.m` hands the keyboard back on a press outside the
// document, on Escape inside it and when it hides; these cover focus that GPUIX moves without a press.
const MOVES = ['focusElement', 'focusNext', 'focusPrevious', 'focusNextWithin', 'focusPreviousWithin'] as const
const installed = new WeakSet<object>()

/** Every programmatic focus move (⌘L, Tab, focus returning from a menu) first takes the keyboard back from a document. */
export function installFocusHandback(renderer: object) {
  if (installed.has(renderer)) return
  installed.add(renderer)
  const target = renderer as Record<string, unknown>
  for (const name of MOVES) {
    const move = target[name]
    if (typeof move !== 'function') continue
    target[name] = function (this: unknown, ...args: unknown[]) {
      webHost.releaseFocus()
      return move.apply(this, args)
    }
  }
}

/** Root `onEvent`: an element that GPUI focuses itself (`autoFocus` on mount) also takes the keyboard back. */
export function handbackOnFocus(event: { eventType: string }) {
  if (event.eventType === 'focus') webHost.releaseFocus()
}
