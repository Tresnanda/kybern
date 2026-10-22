// Minimal Objective-C runtime access through Bun FFI, for the few window
// behaviours GPUIX 0.10.0 does not expose (material, visibility). macOS only;
// callers treat every failure as "keep GPUI's default".
import { dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi'

const LIBOBJC = '/usr/lib/libobjc.A.dylib'

export const cstr = (s: string) => ptr(Buffer.from(`${s}\0`, 'utf8'))

function load() {
  const { symbols: rt } = dlopen(LIBOBJC, {
    objc_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
    sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
    object_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
    class_getName: { args: [FFIType.ptr], returns: FFIType.cstring },
    class_getMethodImplementation: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    class_replaceMethod: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    objc_autoreleasePoolPush: { args: [], returns: FFIType.ptr },
    objc_autoreleasePoolPop: { args: [FFIType.ptr], returns: FFIType.void },
  })
  // `objc_msgSend` has no fixed signature; bind it once per shape used here.
  const send = (args: FFIType[], returns: FFIType) =>
    dlopen(LIBOBJC, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, ...args], returns } }).symbols.objc_msgSend
  return {
    rt,
    msg: send([], FFIType.ptr),
    msgU64: send([], FFIType.u64),
    msgAt: send([FFIType.u64], FFIType.ptr),
    msgSetI64: send([FFIType.i64], FFIType.void),
    msgSetBool: send([FFIType.bool], FFIType.void),
    msgSetPtr: send([FFIType.ptr], FFIType.void),
    msgPtrArg: send([FFIType.ptr], FFIType.ptr),
    msgF64Ptr: send([FFIType.f64], FFIType.ptr),
    msgCStr: send([], FFIType.cstring),
  }
}

export type Objc = ReturnType<typeof load>
let objc: Objc | null = null
const selectors = new Map<string, Pointer>()

export function getObjc(): Objc {
  objc ??= load()
  return objc
}
/**
 * Run `fn` inside an autorelease pool. Bun's main thread has none of its own,
 * so whatever AppKit autoreleases for a call made from JS (the array behind
 * `windows`, the buffer behind `UTF8String`) would otherwise live as long as
 * the process. `fn` must not return an object pointer: the pool releases it.
 */
export function withPool<T>(o: Objc, fn: () => T): T {
  const pool = o.rt.objc_autoreleasePoolPush() as Pointer
  try {
    return fn()
  } finally {
    o.rt.objc_autoreleasePoolPop(pool)
  }
}
export function sel(o: Objc, name: string): Pointer {
  let s = selectors.get(name)
  if (!s) {
    s = o.rt.sel_registerName(cstr(name)) as Pointer
    selectors.set(name, s)
  }
  return s
}
export function cls(o: Objc, name: string): Pointer | null {
  return o.rt.objc_getClass(cstr(name)) as Pointer | null
}
export function className(o: Objc, obj: Pointer): string {
  return String(o.rt.class_getName(o.rt.object_getClass(obj)))
}
export function each(o: Objc, array: Pointer | null, fn: (item: Pointer) => void) {
  if (!array) return
  const n = Number(o.msgU64(array, sel(o, 'count')))
  for (let i = 0; i < n; i++) fn(o.msgAt(array, sel(o, 'objectAtIndex:'), BigInt(i)) as Pointer)
}

let nsAppSymbol: bigint | number | null = null
/**
 * The running `NSApp`, or null before the app exists. Unlike
 * `[NSApplication sharedApplication]` this never creates it: GPUI registers its
 * own NSApplication subclass at startup, and creating the plain class first
 * crashes it ("Ivar platform not found"). Code that may run early uses this.
 */
export function nsApp(): Pointer | null {
  if (!nsAppSymbol) {
    // Not cached while missing: AppKit may not be loaded yet.
    const { symbols } = dlopen('/usr/lib/libSystem.B.dylib', { dlsym: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.ptr } })
    nsAppSymbol = (symbols.dlsym(-2n, cstr('NSApp')) as unknown as number | null) ?? null
    if (!nsAppSymbol) return null
  }
  const app = read.ptr(nsAppSymbol as unknown as Pointer)
  return app ? (app as unknown as Pointer) : null
}
