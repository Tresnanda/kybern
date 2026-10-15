// Optional commit instrumentation, installed before the GPUIX reconciler loads.
const renderers = new Map<number, unknown>()
;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
 supportsFiber: true, renderers,
 inject(renderer: unknown) { renderers.set(1, renderer); return 1 },
 onCommitFiberRoot() { console.error('[idle] react commit') },
 onCommitFiberUnmount() {}, onScheduleFiberRoot() {},
}
await import('../src/main.tsx')

export {}
