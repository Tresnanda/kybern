import type {Pointer} from 'bun:ffi'
// Optional commit instrumentation, installed before the GPUIX reconciler loads.
const renderers = new Map<number, unknown>()
;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
 supportsFiber: true, renderers,
 inject(renderer: unknown) { renderers.set(1, renderer); return 1 },
 onCommitFiberRoot() { console.error('[idle] react commit') },
 onCommitFiberUnmount() {}, onScheduleFiberRoot() {},
}
await import('../src/main.tsx')

// Optional controlled-visibility A/B. Keep our own fixture visible without
// activating it; otherwise parallel background labs can park its loader clock.
if (process.env.KYBERN_IDLE_VISIBLE === '1') {
 const {each,getObjc,nsApp,sel}=await import('../src/native/objc.ts')
 const o=getObjc(),app=nsApp()
 if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,window=>{
  o.msgSetI64(window,sel(o,'setLevel:'),3n)
  o.msg(window,sel(o,'orderFrontRegardless'))
 })
}

export {}
