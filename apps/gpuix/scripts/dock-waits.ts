import type { Locator } from '@gpuix/react/automation'
export const timeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// Poll a condition, rather than assuming a frame or RPC completes after a delay.
export async function until(check: () => Promise<boolean>, label: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { if (await check()) return } catch { /* A locator may not exist yet. */ }
    await timeout(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
export const absent = (locator: Locator) => until(async () => await locator.count() === 0, 'unmount')
export const painted = (locator: Locator, minWidth = 1) => until(async () => {
  const b = await locator.bounds()
  return b.width >= minWidth && b.height > 0
}, 'painted element')
export const openDock = (locator: Locator) => until(async () => {
  const child = await locator.getByTestId('dock-inline').count() ? locator.getByTestId('dock-inline') : locator.getByTestId('dock-overlay')
  const [outer, inner] = await Promise.all([locator.bounds(), child.bounds()])
  return outer.width >= 416 && Math.abs(outer.width - inner.width) < 2
}, 'dock entrance complete')
