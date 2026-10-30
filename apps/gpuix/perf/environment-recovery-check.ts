// Isolated lifecycle check: no native window, daemon or user data.
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
let visible = true
const visibility = new Set<(visible: boolean) => void>()
mock.module('../src/ui.tsx', () => ({ REDUCED_MOTION: false }))
mock.module('../src/native/visibility.ts', () => ({
  isWindowVisible: () => visible,
  onWindowVisibility: (listener: (visible: boolean) => void) => {
    visibility.add(listener)
    return () => visibility.delete(listener)
  },
}))
mock.module('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }))
const store = await import('../src/environment/store.ts')
store.openEnvironmentPanel('first', false)
store.closeEnvironmentPanel()
const closing = store.useEnvironmentPanel()!
await Bun.sleep(930)
assert.equal(store.useEnvironmentPanel()?.generation, closing.generation, 'visible native transition owns completion even after the recovery deadline')
visible = false
for (const listener of visibility) listener(false)
await Bun.sleep(10)
assert.equal(store.useEnvironmentPanel(), null, 'a hidden stalled transition recovers after its deadline')
assert.equal(visibility.size, 0, 'recovery disposes its visibility listener')
visible = true
store.openEnvironmentPanel('second', false)
store.closeEnvironmentPanel()
const stale = store.useEnvironmentPanel()!.generation
store.openEnvironmentPanel('third', false)
store.finishEnvironmentClose(stale)
assert.equal(store.useEnvironmentPanel()?.threadId, 'third', 'stale completion cannot close a reopened panel')
store.closeEnvironmentPanel(true)
assert.equal(store.useEnvironmentPanel(), null)
assert.equal(store.useEnvironmentInstant(), true, 'immediate close retains the content inset policy after unmount')
store.openEnvironmentPanel('keyboard', true)
store.closeEnvironmentPanel()
assert.equal(store.useEnvironmentPanel(), null, 'keyboard close remains immediate')
assert.equal(visibility.size, 0)
console.log('PASS Environment visible completion, hidden recovery, stale completion and immediate/keyboard close')
