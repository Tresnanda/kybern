import { readFileSync } from 'node:fs'
import { nativeCapabilities } from './api.ts'

const registered = new WeakSet<object>()
/** Call once after render creates the native window (e.g. a root layout effect). */
export function registerBrandFonts(renderer: object): void {
  if (registered.has(renderer)) return
  const api = nativeCapabilities(renderer)
  api.registerFont(readFileSync(new URL('../assets/fonts/CalSans-Regular.ttf', import.meta.url)))
  api.registerFont(readFileSync(new URL('../assets/fonts/JetBrainsMono-Regular.ttf', import.meta.url)))
  registered.add(renderer)
}
