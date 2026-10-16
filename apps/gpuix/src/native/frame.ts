// Integration placeholder: pacing7 replaces this with its shared native frame
// subscription. Keep the signature identical so drag code has one scheduler.
const listeners = new Set<(now: number) => void>()
let timer: ReturnType<typeof setInterval> | undefined
export function onFrame(callback: (now: number) => void): () => void {
  listeners.add(callback)
  timer ??= setInterval(() => { const now = performance.now(); listeners.forEach(fn => fn(now)) }, 16)
  return () => { listeners.delete(callback); if (!listeners.size) { clearInterval(timer); timer = undefined } }
}
