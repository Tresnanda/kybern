import path from 'node:path'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { launchFixture } from '../src/requests/harness.ts'
import { CLIENT_DIR, CREDS_DIR, DATA_DIR, SCRATCH, readState, connect, gradientPng } from '../visual/fixture.ts'
import { ids as settingsIds } from '../visual/fixture.settings.ts'
import type { ContentPart } from '../../../packages/kybern-client/src/types.ts'
const out = process.argv[2] ?? '/Users/mymac/projects/ade/previews/gpuix/round3-resume/composer/io'
const light = process.argv.includes('--light')
mkdirSync(out,{recursive:true})
const state = readState()!
const client = await connect(state)
try { await settingsIds(client) } finally { client.close() }
const upstream = readState()!
let sent: ContentPart[] = []
// Echo only this test's send as a provider event. It never reaches a harness or starts a model turn.
const server = Bun.serve<{upstream:WebSocket;queued:string[];pending:Map<number,string>;subscriptions:Map<string,{id:string;seq:number}>}>({hostname:'127.0.0.1',port:0,
  fetch(request, server) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') { const target=new URL(request.url); target.port=String(upstream.port); return fetch(new Request(target,request)) }
    const socket = new WebSocket(`ws://127.0.0.1:${upstream.port}/ws`,{headers:{origin:'tauri://localhost',Authorization:`Bearer ${state.token}`}} as never)
    if (server.upgrade(request,{data:{upstream:socket,queued:[],pending:new Map(),subscriptions:new Map()}})) return
    socket.close(); return new Response('Not found',{status:404})
  },websocket:{
    open(ws) {
      ws.data.upstream.onmessage = event => { const raw=String(event.data), frame=JSON.parse(raw), thread=ws.data.pending.get(frame.id); if (thread && frame.result?.subscription_id) ws.data.subscriptions.set(thread,{id:frame.result.subscription_id,seq:frame.result.head_seq}); ws.send(raw) }
      ws.data.upstream.onopen=()=>{for(const raw of ws.data.queued)ws.data.upstream.send(raw);ws.data.queued=[]}
    },message(ws,raw) {
      const req=JSON.parse(String(raw))
      if(req.method==='events.subscribe' && req.params.thread_id)ws.data.pending.set(req.id,req.params.thread_id)
      if(req.method==='threads.send') {
        sent=req.params.message.parts
        const subscription=ws.data.subscriptions.get(req.params.thread_id)
        if(!subscription)throw Error('No settled transcript subscription')
        ws.send(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{turn_id:'composer-io-turn'}}))
        ws.send(JSON.stringify({jsonrpc:'2.0',method:'event',params:{subscription_id:subscription.id,event:{seq:++subscription.seq,thread_id:req.params.thread_id,turn_id:'composer-io-turn',at:new Date().toISOString(),kind:'turn_started',message_id:'composer-io-user',message:req.params.message}}}))
        return
      }
      if(ws.data.upstream.readyState===WebSocket.OPEN)ws.data.upstream.send(String(raw));else ws.data.queued.push(String(raw))
    },close(ws){ws.data.upstream.close()},
  },
})
const png=path.join(SCRATCH,'clipboard-fixture.png');writeFileSync(png,gradientPng(96,64))
const board=spawn('swift',[path.join(import.meta.dir,'composer-clipboard.swift')],{stdio:['pipe','pipe','pipe']})
const lines:string[]=[], waiters:((line:string)=>void)[]=[];let buffer=''
board.stdout.on('data',chunk=>{buffer+=String(chunk);while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);const waiter=waiters.shift();if(waiter)waiter(line);else lines.push(line)}})
let boardError=''
board.stderr.on('data',chunk=>{boardError=(boardError+String(chunk)).slice(-3000)})
const line=async()=>lines.shift()??await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Clipboard helper timed out: ${boardError}`)),45000);waiters.push(value=>{clearTimeout(timer);resolve(value)})})
const setClipboard=async(kind:string)=>{board.stdin.write(JSON.stringify({kind,path:png})+'\n');if(await line()!=='SET')throw Error('Clipboard changed outside the fixture; stopping')}
let fixture:Awaited<ReturnType<typeof launchFixture>>|undefined
try {
  if(await line()!=='READY')throw Error('Clipboard helper did not start')
  rmSync(path.join(DATA_DIR,'gpuix-ui.json'),{force:true})
  fixture=await launchFixture(path.resolve(import.meta.dir,'../src/main.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_OPAQUE:'1',KYBERN_APPEARANCE:light?'light':'dark',KYBERN_DATA_DIR:DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:CLIENT_DIR,KYBERN_GPUIX_CREDENTIALS_DIR:CREDS_DIR,KYBERN_URL:`ws://127.0.0.1:${server.port}/ws`,KYBERN_TOKEN:state.token,KYBERN_GPUIX_THREAD:'Empty conversation',KYBERN_REDUCED_MOTION:process.env.KYBERN_REDUCED_MOTION??'0'})
  const app=fixture.app
  await app.getByTestId('composer').waitFor({timeoutMs:30000})
  await setClipboard('image');await app.getByTestId('composer').press('cmd-v')
  await app.getByTestId('attachment-image1').waitFor({timeoutMs:15000})
  await app.screenshot({path:path.join(out,'clipboard-image.png')});console.log('PASS clipboard image uploaded and thumbnail mounted')
  await setClipboard('files');await app.getByTestId('composer').press('cmd-v')
  await app.getByTestId('attachment-image2').waitFor({timeoutMs:15000});console.log('PASS Finder file clipboard uploaded')
  const target=await app.getByTestId('composer').center()
  await app.mouse.move(target);await Bun.sleep(150)
  await app.call('fileDrop' as never,{...target,paths:[png]} as never)
  await app.getByTestId('attachment-image3').waitFor({timeoutMs:15000})
  await app.screenshot({path:path.join(out,'file-drop.png')});console.log('PASS native file drop uploaded and thumbnail mounted')
  await setClipboard('text');await app.getByTestId('composer').press('cmd-v')
  const end=Date.now()+5000
  while(!(await app.call('getPaintedText', {})).text.join('\n').includes('Clipboard text fixture')){if(Date.now()>end){ await app.screenshot({path:path.join(out,'plain-text-failure.png')}); throw Error('Plain text paste changed') };await Bun.sleep(20)}
  console.log('PASS plain text paste retains native behavior')
  await app.getByTestId('composer').fill('Clipboard upload fixture')
  const send=await app.getByTestId('send').center();await app.mouse.move(send);await Bun.sleep(150);await app.mouse.click(send)
  const sentEnd=Date.now()+5000;while(!sent.length){if(Date.now()>sentEnd)throw Error('Send was not captured by the mock boundary');await Bun.sleep(20)}
  const images=sent.filter((part):part is Extract<ContentPart,{type:'attachment'}>=>part.type==='attachment')
  if(images.length!==3||images.some(part=>part.media_type!=='image/png'))throw Error(`Uploaded image references did not survive sending: ${images.length} attachments, ${images.map(part=>part.media_type).join(',')}`)
  for(const part of images)await app.getByTestId(`attachment-image-${part.asset_id}`).getByTestId('response-image').waitFor({timeoutMs:15000})
  await app.screenshot({path:path.join(out,'sent-image-thumbnails.png')})
  console.log('PASS uploaded image references and visible sent-bubble thumbnails (mock send; no provider turn)')
  if (!DATA_DIR.includes('gpuix-scratch')) throw Error('Refusing non-scratch fixture persistence')
  const db = new Database(path.join(DATA_DIR, 'state.sqlite'))
  try {
    const row = db.query("SELECT id FROM threads WHERE title = 'Empty conversation'").get() as {id:string}
    db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)').run(row.id, 'composer-io-turn', new Date().toISOString(), 'turn_started', JSON.stringify({kind:'turn_started',message_id:'composer-io-user',message:{parts:sent}}))
    db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)').run(row.id, 'composer-io-turn', new Date().toISOString(), 'turn_completed', JSON.stringify({kind:'turn_completed',stop_reason:'completed',usage:{input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0},duration_ms:0,cost_usd:null}))
    const last = db.query('SELECT max(seq) AS seq FROM events WHERE thread_id=?1').get(row.id) as {seq:number}
    db.prepare('UPDATE threads SET last_seq=?2 WHERE id=?1').run(row.id,last.seq)
  } finally { db.close() }
} finally {
  board.stdin.write(JSON.stringify({kind:'restore'})+'\n');board.stdin.end()
  if(fixture)await fixture.close()
  await server.stop(true)
  await new Promise<void>(resolve=>{if(board.exitCode!==null)resolve();else board.once('exit',()=>resolve())})
}

process.exit(0)
