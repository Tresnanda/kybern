// A press guard for the scenes' primary buttons. A double click, a key repeat, or a click and ⌘↵ together arrive in the same few
// milliseconds; the first moves the flow and the rest are the same intent. `press(fn)` runs `fn` unless it ran within `ms`.

export type Press = (fn: () => void) => boolean

export function createPress(ms = 500, clock: () => number = () => performance.now()): Press {
  let last = -Infinity
  return (fn) => {
    const now = clock()
    if (now - last < ms) return false
    last = now
    fn()
    return true
  }
}
