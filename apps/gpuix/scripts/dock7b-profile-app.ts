// Separate diagnostic run; never use these logged timings as acceptance data.
const renderers = new Map<number, unknown>()
;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, renderers,
  inject(renderer: unknown) { renderers.set(1, renderer); return 1 },
  onCommitFiberRoot() { console.error(`[dock7b-commit] ${performance.now().toFixed(3)}`) },
  onCommitFiberUnmount() {}, onScheduleFiberRoot() {},
}
await import('../src/main.tsx')
export {}
