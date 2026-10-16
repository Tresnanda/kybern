import '../src/native/local-build.ts'
import { render, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { webHost, type WebEvent } from '../src/native/webview.ts'
import { observeElementBounds } from '../src/native/layout.ts'
import { PopupLayer } from '../src/composer/Menu.tsx'
import { ThemeProvider } from '../src/ui.tsx'
import { dlopen, FFIType } from 'bun:ffi'
const input = dlopen(new URL('./build/webview-input.dylib', import.meta.url).pathname, { kybern_web_test_click: { args: [FFIType.f64, FFIType.f64], returns: FFIType.void }, kybern_web_test_type: { args: [], returns: FFIType.void }, kybern_web_test_shortcut: { args: [], returns: FFIType.void } }).symbols
const light = process.env.KYBERN_APPEARANCE === 'light'
const log: WebEvent[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{font:16px system-ui;background:${light?'#ffffff':'#191919'};color:${light?'#161616':'#fafafa'}}body{margin:20px}button,input{font:inherit;padding:8px}button{background:#435cca;color:white;border:0;border-radius:6px}</style><h1>Embedded WKWebView</h1><p>This live document keeps its counter and input across dock / mini transitions.</p><button onclick="this.textContent='Clicked '+(++count);report()">Click counter</button><p><input placeholder="Type here" oninput="report()"></p><a href="https://example.com/">Blocked external navigation</a><script>let count=0;const identity=Math.random().toString(36);function report(){parent.postMessage({kind:'lab',identity,count,input:document.querySelector('input').value},'*')}report();addEventListener('message',event=>{if(event.source===parent){if(event.data.kind==='kybern-visual-host')parent.postMessage({kind:'host-state',visible:event.data.visible,appearance:event.data.theme?.appearance},'*')}})</script>`, { headers: { 'content-type': 'text/html' } }) })
function Lab() {
  const renderer = useGpuixRequired(), slot = useRef<PublicInstance | null>(null)
  const [mini, setMini] = useState(false), [popup, setPopup] = useState(false), [hidden, setHidden] = useState(false), [result, setResult] = useState('')
  useEffect(() => {
    const stop = webHost.subscribe(event => { log.push(event); if (event.type==='loaded') webHost.theme('lab',{appearance:light?'light':'dark',variables:{}}) })
    webHost.create('lab', `http://127.0.0.1:${server.port}/`, 'server')
    return () => {stop();webHost.destroy('lab');server.stop()}
  }, [])
  useEffect(() => {
    if (!slot.current) return
    let apply = () => {}
    const stop = observeElementBounds(renderer,slot.current.id,event=>{
      apply=()=>{const r=event.rect,c=event.clippedRect;if(!r||!c||hidden){webHost.hide('lab');return}webHost.place('lab',r,c,{width:560,height:360,scale:Math.min(r.width/560,r.height/360),left:0,top:0})};apply()
    })
    const events=webHost.subscribe(e=>{if(e.id==='lab'&&(e.type==='created'||e.type==='loaded'))apply()})
    return ()=>{stop();events()}
  }, [renderer, hidden])
  return <div testId="app-ready" onKeyDown={e=>{if(e.key==='c')input.kybern_web_test_click(55,250);if(e.key==='f')input.kybern_web_test_click(80,300);if(e.key==='t')input.kybern_web_test_type();if(e.key==='s')input.kybern_web_test_shortcut();if(e.key==='x')input.kybern_web_test_click(80,350);if(e.key==='m')setMini(n=>!n);if(e.key==='p')setPopup(n=>!n);if(e.key==='h')setHidden(n=>!n);if(e.key==='i')setResult(JSON.stringify(log));if(e.key==='d')webHost.destroy('lab')}} style={{width:'100%',height:'100%',display:'flex',flexDirection:'column',backgroundColor:light?'#f2f2f2':'#242424'}}>
    <text style={{color:light?'#111':'#eee',height:50,padding:12}}>Embedded preview native host</text>
    <div style={{display:'flex',gap:10,paddingLeft:16,height:34}}>{[['m','Dock / mini'],['p','Menu'],['h','Hide / show'],['i','Inspect']].map(([key,label])=><div key={key} testId={`action-${key}`} onClick={()=>{if(key==='m')setMini(n=>!n);if(key==='p')setPopup(n=>!n);if(key==='h')setHidden(n=>!n);if(key==='i')setResult(JSON.stringify(log))}} style={{width:100,height:28,backgroundColor:light?'#ddd':'#444',borderRadius:6}}><text style={{color:light?'#111':'#eee',pointerEvents:'none'}}>{label}</text></div>)}</div>
    <div ref={slot} testId="web-slot" style={{position:'absolute',left:mini?450:20,top:mini?310:100,width:mini?280:560,height:mini?180:360}}/>
    {popup&&<PopupLayer position={{x:100,y:150}} testId="web-menu" style={{width:240,height:180,padding:16,backgroundColor:light?'#fafafa':'#303030',borderRadius:12}}><text style={{color:light?'#111':'#eee'}}>Native page stays behind this GPUI menu.</text></PopupLayer>}
    <text testId="result" style={{position:'absolute',left:10,top:490,width:740,height:100,fontSize:9,color:light?'#111':'#eee'}}>{result}</text>
  </div>
}
render(<ThemeProvider><Lab/></ThemeProvider>,{title:'Kybern embedded preview lab',width:780,height:620,focus:false})
