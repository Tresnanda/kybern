// Windows lab for the embedded web view (WP10, `webview-win-check.ts`): one transparent `visual` document behind a
// rounded clip, served with the daemon's visual CSP and its `bootstrap.js` (so `kybern.answer.draft` is the real one),
// plus a GPUI menu over it, a dimming modal occlusion and the `webHost` ops on keys the check sends through automation.
// The page: a blue band (top 120 px), Count and Choose B buttons, a field, a word to double-click and a scroller; it counts
// the mouse events it gets (`stats`). `/forge` is a hostile page that tries every way to forge picker messages.
import '../src/native/local-build.ts'
import { render, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { useEffect, useRef, useState } from 'react'
import { webHost, type WebEvent } from '../src/native/webview.ts'
import { observeElementBounds } from '../src/native/layout.ts'
import { PopupLayer } from '../src/composer/Menu.tsx'
import { ThemeProvider } from '../src/ui.tsx'
import { PICKER_SOURCE } from '../src/pick/pickerScript.ts'

const log: WebEvent[] = []
/** Keys that reached GPUI's own key handling (they must stop once a page has the keyboard). */
const appKeys: string[] = []
/** Mouse events GPUI's own root got (a GPUI drag across the page must keep reaching it). */
const mouse = { down: 0, up: 0, move: 0 }
const bootstrap = readFileSync(path.join(import.meta.dir, '../../../crates/kybern-daemon/src/visuals/bootstrap.js'), 'utf8')
const POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https: http:; font-src data: https:; connect-src https:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
const page = `<!doctype html><meta charset=utf-8><script>${bootstrap}</script><style>
html,body{margin:0;background:transparent;font:16px system-ui;color:#fff}#band{position:absolute;left:0;top:0;width:560px;height:120px;background:rgb(0,120,255)}
button,input{position:absolute;font:inherit}#count{left:20px;top:140px;width:120px;height:36px}#choose{left:220px;top:140px;width:120px;height:36px}
#field{left:20px;top:190px;width:160px;height:28px}#word{position:absolute;left:300px;top:196px;user-select:text}
#scroller{position:absolute;left:20px;top:240px;width:200px;height:80px;overflow:auto;background:rgba(255,255,255,.1)}</style>
<div id=band></div><button id=count>Count</button><button id=choose>Choose B</button><input id=field><span id=word>doubleword</span>
<div id=scroller><div style="height:600px">scroll me</div></div><script>
const report=data=>parent.postMessage(data,'*');let count=0
document.getElementById('count').onclick=()=>report({kind:'lab',count:++count})
document.getElementById('choose').onclick=()=>window.kybern.answer.draft({choice:'B'},{label:'Option B'})
document.getElementById('field').oninput=e=>report({kind:'lab',input:e.target.value})
document.getElementById('word').ondblclick=()=>report({kind:'lab',dblclick:String(getSelection())})
document.getElementById('scroller').onscroll=e=>report({kind:'lab',scrolled:e.target.scrollTop})
const stats={down:0,up:0,move:0};for(const [type,key] of [['mousedown','down'],['mouseup','up'],['mousemove','move']])document.addEventListener(type,()=>stats[key]++,true)
addEventListener('message',e=>{if(e.source!==parent||!e.data)return;if(e.data.kind==='ping')report({kind:'pong',got:e.data.value});if(e.data.kind==='stats')report({kind:'stats',...stats});if(e.data.kind==='kybern-visual-host')report({kind:'host-state',visible:e.data.visible})})
report({kind:'lab',ready:true,title:document.title})
</script>`
/**
 * A page that tries to forge the picker: WebKit's and WebView2's message objects in its own world, a guessed binding,
 * a picker and history functions defined before Kybern's, and synthetic ⌥-clicks, clicks, Enter, Escape and popstate.
 * It reports what it could reach (`forge` messages through the visual's own channel), never a pick.
 */
const forge = `<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:transparent;font:16px system-ui;color:#fff}
#target{position:absolute;left:40px;top:140px;width:200px;height:80px;background:rgb(0,120,255)}</style><div id=target>target</div><script>
const report=data=>parent.postMessage(data,'*')
const fake=(event)=>({kind:'pick',event,payload:{selector:'#forged',tag:'div',text:'forged',box:{x:1,y:1,width:10,height:10}}})
const tries={}
try{window.webkit.messageHandlers.kybernFrame.postMessage(fake('anchor'));tries.webkit='sent'}catch(e){tries.webkit='unreachable'}
try{for(const m of [{kybernFrame:fake('anchor')},{kybernFrame:fake('picked')},{kybernFrame:fake('cancelled')},{kybernFrame:'escape'},{kybernFrame:'frame'}])window.chrome.webview.postMessage(m);tries.chromeWebview='sent'}catch(e){tries.chromeWebview='unreachable'}
try{window.__kybernFrameBinding(JSON.stringify({kybernFrame:fake('anchor'),url:location.href}));tries.binding='sent'}catch(e){tries.binding='unreachable'}
window.__kybernPicker={start(){report({kind:'forge',fake:'start'});return 'fake'},stop(){report({kind:'forge',fake:'stop'});return 'fake'}}
try{history.pushState({},'','#two');tries.pushState=location.hash}catch(e){tries.pushState=String(e)}
history.back=()=>report({kind:'forge',fake:'back'});history.forward=()=>report({kind:'forge',fake:'forward'})
const target=document.getElementById('target')
function fire(){
  for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,composed:true,altKey:true,button:0,clientX:60,clientY:160}))
  target.click()
  for(const key of ['Enter','Escape'])document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}))
  dispatchEvent(new PopStateEvent('popstate'));dispatchEvent(new HashChangeEvent('hashchange'))
  try{window.webkit.messageHandlers.kybernFrame.postMessage(fake('picked'))}catch(e){}
}
addEventListener('message',e=>{if(e.source!==parent||!e.data)return;if(e.data.kind==='forge-fire'){fire();report({kind:'forge',fired:true})}})
report({kind:'forge',ready:true,tries})
</script>`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new Response(new URL(request.url).pathname === '/forge' ? forge : page, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': POLICY, 'cache-control': 'no-store' } }) })

function Lab() {
  const renderer = useGpuixRequired(), slot = useRef<PublicInstance | null>(null)
  const [popup, setPopup] = useState(false), [hidden, setHidden] = useState(false), [dim, setDim] = useState(false), [result, setResult] = useState('')
  useEffect(() => {
    const stop = webHost.subscribe(event => {
      log.push(event)
      if (event.type === 'snapshot' || event.type === 'frameResult' || event.type === 'snapshotRect') setResult(JSON.stringify(event))
    })
    webHost.create('lab', `http://127.0.0.1:${server.port}/`, 'visual')
    return () => { stop(); webHost.destroy('lab'); server.stop() }
  }, [])
  useEffect(() => {
    if (!slot.current) return
    let apply = () => {}
    const stop = observeElementBounds(renderer, slot.current.id, event => {
      apply = () => { const r = event.rect, c = event.clippedRect; if (!r || !c || hidden) { webHost.hide('lab'); return } webHost.place('lab', r, c, { width: 560, height: 360, scale: 1, left: 0, top: 0, roundedClips: event.roundedClips }) }
      apply()
    })
    const events = webHost.subscribe(e => { if (e.id === 'lab' && (e.type === 'created' || e.type === 'loaded')) apply() })
    return () => { stop(); events() }
  }, [renderer, hidden])
  useEffect(() => { webHost.occlusion(900, dim ? { x: 0, y: 0, width: 780, height: 620 } : null, 0, 0.5, 900) }, [dim])
  const temp = (name: string) => path.join(tmpdir(), `kybern-webview-win-${process.pid}-${name}.png`)
  const act = (key: string) => {
    if (key === 'i') setResult(JSON.stringify({ log, appKeys, mouse }))
    if (key === 'p') setPopup(n => !n)
    if (key === 'd') setDim(n => !n)
    if (key === 'h') setHidden(n => !n)
    if (key === 'e') webHost.present('lab', { opacity: 1, scale: 1 }, { from: { opacity: 0, scale: 0.9 }, duration: 0.6, ease: [0.23, 1, 0.32, 1], origin: [0.5, 0.5] })
    if (key === 'g') webHost.probe('lab')
    if (key === 'n') webHost.send('lab', { kind: 'ping', value: 42 })
    if (key === 's') webHost.snapshot('lab', temp('snapshot'), 7)
    if (key === 'r') webHost.snapshotRect('lab', { x: 0, y: 0, width: 200, height: 100 }, temp('rect')).then(v => setResult(JSON.stringify({ rect: v })), e => setResult(JSON.stringify({ rectError: String(e) })))
    if (key === 'f') webHost.frame('lab', "({ href: location.href, band: getComputedStyle(document.getElementById('band')).backgroundColor })").then(v => setResult(JSON.stringify({ frame: v })), e => setResult(JSON.stringify({ frameError: String(e) })))
    if (key === 'k') webHost.focus('lab')
    if (key === 'm') webHost.send('lab', { kind: 'stats' })
    if (key === 'v') webHost.navigate('lab', `http://127.0.0.1:${server.port}/forge`)
    if (key === 'y') webHost.send('lab', { kind: 'forge-fire' })
    if (key === 'b') webHost.action('lab', 'back')
    const frame = (name: string, script: string) => webHost.frame('lab', script).then(v => setResult(JSON.stringify({ [name]: v })), e => setResult(JSON.stringify({ [name]: { error: String(e) } })))
    if (key === 'q') void frame('install', PICKER_SOURCE)
    if (key === 'w') void frame('start', 'window.__kybernPicker.start("Pick something")')
    if (key === 'u') void frame('stop', 'window.__kybernPicker.stop()')
    if (key === 'o') void frame('page', '({ hasBinding: typeof window.__kybernFrameBinding, picker: typeof window.__kybernPicker, hash: location.hash })')
    if (key === 'x') webHost.destroy('lab')
  }
  return <div testId="app-ready" onKeyDown={e => act(e.key ?? '')} onMouseDown={() => { mouse.down++ }} onMouseUp={() => { mouse.up++ }} onMouseMove={() => { mouse.move++ }} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#242424' }}>
    <text style={{ color: '#eee', height: 50, padding: 12 }}>Embedded web view (Windows) lab</text>
    <div style={{ position: 'absolute', left: 20, top: 100, width: 560, height: 360, borderRadius: 28, overflow: 'hidden' }}><div ref={slot} testId="web-slot" style={{ width: '100%', height: '100%' }} /></div>
    {popup && <PopupLayer position={{ x: 100, y: 150 }} testId="web-menu" style={{ width: 240, height: 180, padding: 16, backgroundColor: '#303030', borderRadius: 12 }}><text style={{ color: '#eee' }}>A GPUI menu over the page.</text></PopupLayer>}
    <text testId="result" style={{ position: 'absolute', left: 10, top: 490, width: 760, height: 120, fontSize: 9, color: '#eee' }}>{result}</text>
  </div>
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'Kybern embedded web view lab (Windows)', width: 780, height: 620, focus: true, onKeyDown: e => { if (e.key) appKeys.push(e.key) } })
