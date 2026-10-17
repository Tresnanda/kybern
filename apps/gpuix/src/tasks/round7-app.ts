import {dlopen,FFIType,type Pointer} from 'bun:ffi'
await import('../main.tsx')
const {each,getObjc,nsApp,sel}=await import('../native/objc.ts')
const o=getObjc(),app=nsApp()
if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,window=>{
 o.msgSetI64(window,sel(o,'setLevel:'),3n)
 // AppKit constrains initial GPUI windows to this laptop's screen. A wide
 // comparison needs an actual wide content viewport, including its offscreen
 // portion; arm64 passes CGSize's two doubles in the same HFA registers.
 if(process.env.KYBERN_WINDOW_SIZE?.startsWith('1920x')){
  const {symbols}=dlopen('/usr/lib/libobjc.A.dylib',{objc_msgSend:{args:[FFIType.ptr,FFIType.ptr,FFIType.f64,FFIType.f64],returns:FFIType.void}})
  symbols.objc_msgSend(window,sel(o,'setContentSize:'),1920,820)
 }
 o.msg(window,sel(o,'orderFrontRegardless'))
})
export {}
