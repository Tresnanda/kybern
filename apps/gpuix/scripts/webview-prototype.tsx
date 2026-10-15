// Isolated feasibility probe only. Never imported by the production client.
import { dlopen, FFIType, ptr, type Pointer } from 'bun:ffi'
import { cls, cstr, each, getObjc, nsApp, sel } from '../src/native/objc.ts'
import assert from 'node:assert/strict'
import '../src/main.tsx'
assert.equal(process.env.KYBERN_DATA_DIR, '/Users/mymac/projects/ade-gpuix-scratch/data')
const o = getObjc()
const setArgument = dlopen('/usr/lib/libobjc.A.dylib', { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void } }).symbols.objc_msgSend
function rectCall(object: Pointer, method: string, values: number[]) {
  const signature = o.msgPtrArg(object, sel(o, 'methodSignatureForSelector:'), sel(o, method)) as Pointer
  const invocation = o.msgPtrArg(cls(o, 'NSInvocation'), sel(o, 'invocationWithMethodSignature:'), signature) as Pointer
  o.msgSetPtr(invocation, sel(o, 'setTarget:'), object); o.msgSetPtr(invocation, sel(o, 'setSelector:'), sel(o, method))
  const bytes = Buffer.alloc(32); values.forEach((value, i) => bytes.writeDoubleLE(value, i * 8))
  setArgument(invocation, sel(o, 'setArgument:atIndex:'), ptr(bytes), 2n)
  o.msg(invocation, sel(o, 'invoke'))
}
let view: Pointer | null = null
const timer = setInterval(() => {
  const app = nsApp(); if (!app) return
  let window: Pointer | null = null
  each(o, o.msg(app, sel(o, 'windows')) as Pointer, w => { if (!window && o.msgU64(w, sel(o, 'isVisible'))) window = w })
  if (!window) return
  clearInterval(timer)
  const content = o.msg(window, sel(o, 'contentView')) as Pointer
  view = o.msg(o.msg(cls(o, 'WKWebView'), sel(o, 'alloc')) as Pointer, sel(o, 'init')) as Pointer
  rectCall(view, 'setFrame:', [700, 100, 420, 480])
  o.msgSetPtr(content, sel(o, 'addSubview:'), view)
  const string = o.msgPtrArg(cls(o, 'NSString'), sel(o, 'stringWithUTF8String:'), cstr(`http://127.0.0.1:${server.port}/`)) as Pointer
  const url = o.msgPtrArg(cls(o, 'NSURL'), sel(o, 'URLWithString:'), string) as Pointer
  const request = o.msgPtrArg(cls(o, 'NSURLRequest'), sel(o, 'requestWithURL:'), url) as Pointer
  o.msgPtrArg(view, sel(o, 'loadRequest:'), request)
  console.log('[WK prototype]', JSON.stringify({ window: Number(o.msgU64(window, sel(o, 'windowNumber'))), mainThread: !!o.msgU64(cls(o, 'NSThread'), sel(o, 'isMainThread')), attached: !!o.msg(view, sel(o, 'superview')), visible: true }))
}, 50)
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<!doctype html><style>body{font:20px system-ui;background:#ebf2ff;padding:24px}button,input{font:inherit;padding:8px}</style><h1>Native WKWebView probe</h1><p>Child NSView hosted over GPUI.</p><input placeholder="Keyboard and focus"><p><button onclick="this.textContent=\'Clicked\'">Click to verify</button></p>') })
setTimeout(() => { if (view) { o.msg(view, sel(o, 'stopLoading')); o.msg(view, sel(o, 'removeFromSuperview')); o.msg(view, sel(o, 'release')) }; server.stop(); process.exit(0) }, 45000)
