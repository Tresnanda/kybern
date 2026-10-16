import { dlopen, FFIType, JSCallback, ptr } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { LayoutRect, RoundedLayoutClip } from './layout.ts'

export type WebEvent = { id: string; generation?: number; type: string; message?: string; url?: string; visible?: boolean; key?: string; modifiers?: { cmd: boolean; ctrl: boolean; alt: boolean; shift: boolean }; data?: Record<string, unknown> }
let bridge: ReturnType<typeof load> | undefined, wake: JSCallback | undefined
let nextGeneration = 0
let pointerCaptures = 0
const listeners = new Set<(event: WebEvent) => void>()
const occlusions = new Map<number, { rect: LayoutRect; radius: number; dim: number; order: number; inputOnly: boolean }>()
function load(file: string) {
  return dlopen(file, {
    kybern_web_init: { args: [FFIType.ptr], returns: FFIType.void },
    kybern_web_next: { args: [], returns: FFIType.cstring },
    kybern_web_command: { args: [FFIType.ptr], returns: FFIType.void },
  })
}
function initialize() {
  if (bridge) return
  const file = process.env.KYBERN_GPUIX_RESOURCES
    ? `${process.env.KYBERN_GPUIX_RESOURCES}/kybern-webview.dylib`
    : fileURLToPath(new URL('../../native/build/kybern-webview.dylib', import.meta.url))
  if (!existsSync(file)) throw Error('Build the embedded preview host with bun native/build-webview.ts, then reopen Kybern.')
  const loaded = load(file)
  wake = new JSCallback(() => {
    for (;;) {
      const raw = loaded.symbols.kybern_web_next()
      if (!raw) break
      const event = JSON.parse(String(raw)) as WebEvent
      for (const listener of listeners) { try { listener(event) } catch (e) { console.error('[webview]', e) } }
    }
  }, { args: [], returns: FFIType.void, threadsafe: true })
  loaded.symbols.kybern_web_init(wake.ptr); bridge = loaded
  for (const [layer, value] of occlusions) command({ op: 'occlusion', id: '', layer, ...value })
  if (pointerCaptures) command({ op: 'capture', id: '', active: true })
}
function command(fields: Record<string, unknown>) {
  initialize()
  const bytes = Buffer.from(JSON.stringify(fields) + '\0')
  bridge!.symbols.kybern_web_command(ptr(bytes))
}

/** Trusted wrapper, opaque sandboxed child. No bearer token or native bridge is
 * exposed to the child. The daemon supplies the child's actual CSP. */
export function webDocument(url: string, kind: 'file' | 'server' | 'visual') {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw Error('Invalid preview address')
  const sandbox = kind === 'visual' ? 'allow-scripts' : kind === 'file' ? 'allow-scripts allow-forms allow-modals' : 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads'
  const value = JSON.stringify(url).replaceAll('<', '\\u003c')
  return `<!doctype html><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{border:0;position:absolute;transform-origin:0 0;width:100%;height:100%}</style><iframe sandbox="${sandbox}" referrerpolicy="no-referrer"></iframe><script>
  const frame=document.querySelector('iframe'), send=data=>window.webkit.messageHandlers.kybern.postMessage(data);
  let visible=true, theme, last='';
  function post(force=false){const data={kind:'kybern-visual-host',visible,theme};const key=JSON.stringify(data);if(force||key!==last){last=key;frame.contentWindow?.postMessage(data,'*');frame.contentWindow?.postMessage({type:'kybern-preview-visibility',visible},'*')}}
  window.kybernVisible=value=>{visible=value;post()};window.kybernTheme=value=>{theme=value;document.documentElement.style.background=value.variables?.['--background']||'transparent';post()};
  window.kybernLayout=(w,h,scale,left,top)=>{Object.assign(frame.style,{width:w+'px',height:h+'px',transform:'translate('+left+'px,'+top+'px) scale('+scale+')'})};
  window.kybernCommand=action=>{if(action==='reload')frame.src=frame.src;else if(action==='back'||action==='forward')frame.contentWindow.postMessage({type:'go',delta:action==='back'?-1:1},'*')};
  window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||!event.data||typeof event.data!=='object')return;if(event.data.kind==='kybern-visual-link'&&!navigator.userActivation?.isActive)return;send(event.data)});
  frame.onload=()=>{post(true);send({kind:'loaded'})};frame.src=${value};
  </script>`
}

export const webHost = {
  create(id: string, url: string, kind: 'file' | 'server' | 'visual') {
    const generation = ++nextGeneration
    command({ op: 'create', id, category: kind === 'visual' ? 'visual' : 'preview', generation, allowedOrigins: [new URL(url).origin], html: webDocument(url, kind) })
    return generation
  },
  place(id: string, rect: LayoutRect, clip: LayoutRect, logical: { width: number; height: number; scale: number; left: number; top: number; radius?: number; roundedClips?: RoundedLayoutClip[] | null }, visible = true, layer = 0) {
    if (!bridge) return
    command({ op: 'place', id, x: clip.x, y: clip.y, width: clip.width, height: clip.height, offsetX: rect.x - clip.x, offsetY: rect.y - clip.y, logicalWidth: rect.width, logicalHeight: rect.height, visible,
      layer, radius: logical.radius ?? 0, roundedClips: logical.roundedClips ?? [], layout: `window.kybernLayout?.(${[logical.width, logical.height, logical.scale, logical.left, logical.top].join(',')})` })
  },
  hide(id: string) { if (bridge) command({ op: 'hide', id }) },
  post(id: string, script: string) { command({ op: 'post', id, script }) },
  theme(id: string, theme: unknown) { command({ op: 'post', id, script: `window.kybernTheme?.(${JSON.stringify(theme)})` }) },
  navigate(id: string, url: string) { command({ op: 'navigate', id, url }) },
  action(id: string, action: 'reload' | 'back' | 'forward' | 'stop') { command({ op: 'action', id, action }) },
  destroy(id: string) { if (bridge) command({ op: 'destroy', id }) },
  capturePointer() {
    if (++pointerCaptures === 1 && bridge) command({ op: 'capture', id: '', active: true })
    let live = true
    return () => { if (!live) return; live = false; if (--pointerCaptures === 0 && bridge) command({ op: 'capture', id: '', active: false }) }
  },
  occlusion(layer: number, rect: LayoutRect | null, radius = 0, dim = 0, order = layer, inputOnly = false) {
    if (rect) occlusions.set(layer, { rect, radius, dim, order, inputOnly }); else occlusions.delete(layer)
    if (bridge) command({ op: 'occlusion', id: '', layer, rect, radius, dim, order, inputOnly })
  },
  subscribe(listener: (event: WebEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
}
