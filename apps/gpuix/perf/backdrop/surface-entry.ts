import '../../native/surface-lab.tsx'
import type {Pointer} from 'bun:ffi'
import {each,getObjc,nsApp,sel} from '../../src/native/objc.ts'
const o=getObjc(),app=nsApp()
if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,window=>{
 o.msgSetI64(window,sel(o,'setLevel:'),3n)
 o.msgSetBool(window,sel(o,'setIgnoresMouseEvents:'),true)
 o.msgSetBool(window,sel(o,'setAcceptsMouseMovedEvents:'),false)
 o.msg(window,sel(o,'orderFrontRegardless'))
})
