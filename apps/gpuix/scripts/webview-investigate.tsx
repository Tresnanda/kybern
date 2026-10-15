// Read-only native capability probe; launched only against the scratch daemon.
import { dlopen, FFIType } from 'bun:ffi'
import { cls, getObjc, nsApp, sel } from '../src/native/objc.ts'
import assert from 'node:assert/strict'
import '../src/main.tsx'
assert.equal(process.env.KYBERN_DATA_DIR, '/Users/mymac/projects/ade-gpuix-scratch/data')
const timer = setInterval(() => {
  if (!nsApp()) return
  clearInterval(timer)
  const o = getObjc()
  console.log('[webview probe]', JSON.stringify({ mainThread: !!o.msgU64(cls(o, 'NSThread'), sel(o, 'isMainThread')), webkitLoaded: !!cls(o, 'WKWebView') }))
  try {
    // Loading the system framework is enough to register WKWebView. No view is
    // instantiated or attached from the Bun thread.
    dlopen('/System/Library/Frameworks/WebKit.framework/WebKit', { WKGetTypeID: { args: [], returns: FFIType.u64 } })
    console.log('[webview probe] WKWebView registered:', !!cls(o, 'WKWebView'))
  } catch (e) { console.log('[webview probe] framework load:', String(e)) }
}, 50)
setTimeout(() => process.exit(0), 5000)
