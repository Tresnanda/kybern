// The full app with a visual and a Preview page, driven at the AppKit level by `focus-app-check.ts` (ADE-69).
import '../src/main.tsx'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dlopen, FFIType } from 'bun:ffi'
import { getState, selectThread } from '../src/state.ts'
import { showPreview, openPreview } from '../src/preview/store.ts'
import { webHost } from '../src/native/webview.ts'
const output = process.env.KYBERN_FOCUS_EVENTS!, commands = process.env.KYBERN_FOCUS_COMMANDS!, thread = process.env.KYBERN_GPUIX_THREAD!, target = process.env.KYBERN_PREVIEW_TARGET!
const input = dlopen(new URL('../native/build/webview-input.dylib', import.meta.url).pathname, {
  kybern_web_test_target: { args: [FFIType.i64], returns: FFIType.void },
  kybern_web_test_click: { args: [FFIType.f64, FFIType.f64], returns: FFIType.void },
  kybern_web_test_press: { args: [FFIType.f64, FFIType.f64], returns: FFIType.void },
  kybern_web_test_key: { args: [FFIType.cstring, FFIType.u16], returns: FFIType.void },
  kybern_web_test_responder: { args: [], returns: FFIType.i32 },
}).symbols
const write = (event: unknown) => appendFileSync(output, JSON.stringify(event) + '\n')
webHost.subscribe(event => {
  write(event)
  const windowNumber = (event as { windowNumber?: unknown }).windowNumber
  if (event.type === 'created' && typeof windowNumber === 'number') input.kybern_web_test_target(windowNumber)
})
const deadline = Date.now() + 20000
while (!getState().listsLoaded || getState().status !== 'open') { if (Date.now() > deadline) throw Error('Focus fixture connection timed out'); await Bun.sleep(30) }
await selectThread(thread)
// Commands arrive as lines in a file, not through automation: automation focuses elements itself (`focusElement`),
// which would hand the keyboard back on every step.
let done = 0
setInterval(() => {
  const lines = existsSync(commands) ? readFileSync(commands, 'utf8').split('\n').filter(Boolean) : []
  for (; done < lines.length; done++) {
    const c = JSON.parse(lines[done]!) as { op: string; x?: number; y?: number; chars?: string; code?: number; id?: number }
    if (c.op === 'click') input.kybern_web_test_click(c.x!, c.y!)
    if (c.op === 'press') input.kybern_web_test_press(c.x!, c.y!)
    if (c.op === 'key') input.kybern_web_test_key(Buffer.from(c.chars! + '\0'), c.code!)
    if (c.op === 'preview') { showPreview(thread); void openPreview(thread, target) }
    if (c.op === 'responder') write({ type: 'responder', id: c.id, value: input.kybern_web_test_responder() })
  }
}, 50)
