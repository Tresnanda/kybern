// The full app with the inline pages of `inline-visual-check.ts`, driven at the AppKit level: wheel events with their
// phases go through NSApp (local monitors, then AppKit's hit test), presses and drags reach the view under them.
import '../src/main.tsx'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dlopen, FFIType } from 'bun:ffi'
import { getState, selectThread } from '../src/state.ts'
import { webHost } from '../src/native/webview.ts'
import { liveSlotCount } from '../src/transcript/visualDocs.ts'
const output = process.env.KYBERN_FOCUS_EVENTS!, commands = process.env.KYBERN_FOCUS_COMMANDS!, thread = process.env.KYBERN_GPUIX_THREAD!
const input = dlopen(new URL('../native/build/webview-input.dylib', import.meta.url).pathname, {
  kybern_web_test_target: { args: [FFIType.i64], returns: FFIType.void },
  kybern_web_test_click: { args: [FFIType.f64, FFIType.f64], returns: FFIType.void },
  kybern_web_test_press: { args: [FFIType.f64, FFIType.f64], returns: FFIType.void },
  kybern_web_test_scroll: { args: [FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.i32, FFIType.i32], returns: FFIType.void },
  kybern_web_test_chord: { args: [FFIType.cstring, FFIType.u16, FFIType.u64], returns: FFIType.void },
  kybern_web_test_drag: { args: [FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.i32], returns: FFIType.void },
  kybern_web_test_responder: { args: [], returns: FFIType.i32 },
}).symbols
const write = (event: unknown) => appendFileSync(output, JSON.stringify(event) + '\n')
webHost.subscribe(event => {
  if (event.type === 'message' && event.data?.kind === 'kybern-visual-hover') return
  write(event)
  const windowNumber = (event as { windowNumber?: unknown }).windowNumber
  if (event.type === 'created' && typeof windowNumber === 'number') input.kybern_web_test_target(windowNumber)
})
const deadline = Date.now() + 20000
while (!getState().listsLoaded || getState().status !== 'open') { if (Date.now() > deadline) throw Error('Fixture connection timed out'); await Bun.sleep(30) }
await selectThread(thread)
type Command = { op: string; id?: number; x?: number; y?: number; x2?: number; y2?: number; dx?: number; dy?: number; phase?: number; momentum?: number; steps?: number; chars?: string; code?: number; flags?: number; doc?: string; script?: string; data?: Record<string, unknown> }
let done = 0
// Wheel events leave one per display frame, as a trackpad sends them; the command file is read in bursts.
const wheel: Command[] = []
setInterval(() => { const c = wheel.shift(); if (c) input.kybern_web_test_scroll(c.x!, c.y!, c.dx ?? 0, c.dy ?? 0, c.phase ?? 0, c.momentum ?? 0) }, 16)
setInterval(() => {
  const lines = existsSync(commands) ? readFileSync(commands, 'utf8').split('\n').filter(Boolean) : []
  for (; done < lines.length; done++) {
    const c = JSON.parse(lines[done]!) as Command
    if (c.op === 'click') input.kybern_web_test_click(c.x!, c.y!)
    if (c.op === 'press') input.kybern_web_test_press(c.x!, c.y!)
    if (c.op === 'scroll') wheel.push(c)
    if (c.op === 'chord') input.kybern_web_test_chord(Buffer.from(c.chars! + '\0'), c.code!, BigInt(c.flags ?? 0))
    if (c.op === 'drag') input.kybern_web_test_drag(c.x!, c.y!, c.x2!, c.y2!, c.steps ?? 8)
    if (c.op === 'send') webHost.send(c.doc!, c.data!)
    if (c.op === 'responder') write({ type: 'responder', id: c.id, value: input.kybern_web_test_responder() })
    if (c.op === 'idle') write({ type: 'idle', id: c.id, pending: wheel.length })
    if (c.op === 'docs') write({ type: 'docs', id: c.id, documents: webHost.documents(), live: liveSlotCount() })
    if (c.op === 'eval') { const id = c.id; webHost.frame(c.doc!, c.script!).then(value => write({ type: 'eval', id, value }), error => write({ type: 'eval', id, error: String(error) })) }
  }
}, 30)
