// Integration seam for the shell agent's per-environment store. During the
// isolated page build these values survive route changes for this process.
// When merging, replace this adapter with:
// export { load, save } from '../shell/persist.ts'
// Do not introduce another on-disk preferences format here.
const session = new Map<string, unknown>()
export function load<T>(key: string, fallback: T): T {
  return session.has(key) ? session.get(key) as T : fallback
}
export function save<T>(key: string, value: T): void { session.set(key, value) }
