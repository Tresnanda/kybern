import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../src/requests/harness.ts'
import { acquirePreviewUiLock } from './preview-ui-lock.ts'

async function main() {
const scratch = '/Users/mymac/projects/ade-gpuix-scratch/round5/preview', data = path.join(scratch, 'data')
const out = '/Users/mymac/projects/ade/previews/gpuix/round5/preview'
mkdirSync(out, { recursive: true })
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'),'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'),'utf8').trim() })
client.connect(); while (client.status !== 'open') await Bun.sleep(30)
const project = (await client.call('projects.list',{})).projects.find(p=>p.name==='scratch-project')!
const thread = await client.call('threads.create',{project_id:project.id, title:'Embedded preview verification',provider:{kind:'claude-code',instance:'default'},model:'claude-haiku-5-5'})
const db = new Database(path.join(data,'state.sqlite')), turn=crypto.randomUUID(), message=crypto.randomUUID()
db.transaction(()=>{
  const insert=db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
  for(const event of [{kind:'turn_started',message_id:crypto.randomUUID(),message:{parts:[{type:'text',text:'Show the embedded preview and interactive visual.'}]}},{kind:'assistant_message_completed',message_id:message,origin:{kind:'root'},text:'The page below uses the same theme as the conversation.',thinking:null},{kind:'turn_completed',stop_reason:'completed',usage:{input_tokens:1,output_tokens:1,cache_read_tokens:0,cache_write_tokens:0},duration_ms:1,terminal_message_id:message}])insert.run(thread.id,turn,new Date().toISOString(),event.kind,JSON.stringify(event))
  db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?').run(thread.id,thread.id)
})(); db.close()
await client.call('threads.visuals.publish',{thread_id:thread.id,title:'Interactive preview',height:280,html:`<!doctype html><style>body{font:14px system-ui;padding:16px}h2{font-size:20px;margin:0 0 12px}button{font:inherit;background:var(--accent);color:white;border:0;padding:8px 14px;border-radius:8px}.bars{display:flex;gap:8px;height:70px;align-items:end;margin:12px 0}.bars i{flex:1;background:var(--chart-1);border-radius:5px}.bars i:nth-child(2){height:70%;background:var(--chart-2)}.bars i:nth-child(3){height:50%;background:var(--chart-3)}</style><h2>Interactive visual</h2><div class="bars"><i style="height:100%"></i><i></i><i></i></div><button onclick="this.textContent='Count '+(++count)">Count 0</button><script>let count=0;parent.postMessage({kind:'fixture-visual',identity:Math.random().toString(36)},'*');addEventListener('kybern-visibility',e=>parent.postMessage({kind:'fixture-visibility',visible:e.detail.visible},'*'));(async()=>{let parentReadable=false;try{void parent.document.body;parentReadable=true}catch{};let localFetch='blocked';try{localFetch=String((await fetch('http://127.0.0.1:4237/health')).status)}catch{};try{window.webkit.messageHandlers.kybern.postMessage({kind:'forged-main'})}catch{};parent.postMessage({kind:'fixture-security',parentReadable,localFetch,origin:self.origin,isolatedHandler:typeof window.webkit?.messageHandlers?.kybernFrame},'*')})()</script>`})
const file=path.join(project.path,'embedded.html')
writeFileSync(file,`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px system-ui;padding:20px;background:#e9eef8;color:#172346}h1{font-size:24px}button,input{font:inherit;padding:8px;border-radius:6px}</style><h1>Local HTML preview</h1><p>This document stays alive when moved.</p><button onclick="this.textContent='Count '+(++count)">Count 0</button><p><input placeholder="Keep typing here"></p><a href="#next">History link</a><script>let count=0;parent.postMessage({kind:'fixture-page',identity:Math.random().toString(36),file:true},'*')</script>`)
let assets=0
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){if(new URL(req.url).pathname==='/asset.js'){assets++;return new Response(`document.querySelector('h1').textContent='Localhost app · root asset loaded';parent.postMessage({kind:'fixture-page',identity:Math.random().toString(36),asset:true},'*')`,{headers:{'content-type':'text/javascript'}})}return new Response('<!doctype html><style>body{font:14px system-ui;padding:20px;background:#def5ed;color:#163f34}h1{font-size:24px}</style><h1>Localhost app</h1><input placeholder="Edit the app"><p><button onclick="this.textContent=\'Clicked\'">Click</button></p><script src="/asset.js"></script>',{headers:{'content-type':'text/html'}})}})
try {for(const appearance of ['dark','light']) for(const reduced of ['0','1']){
  const tag=`${appearance}-${reduced==='1'?'reduced':'normal'}`, events=path.join(out,`events-${tag}.jsonl`);writeFileSync(events,'')
  if (process.env.KYBERN_PREVIEW_CASE && process.env.KYBERN_PREVIEW_CASE !== tag) continue
  const processes = () => execFileSync('ps',['-axo','pid,comm'],{encoding:'utf8'}).split('\n').filter(line=>/com\.apple\.WebKit\.(WebContent|GPU|Networking)$/.test(line.trim())).map(line=>Number(line.trim().split(/\s+/)[0]))
  const before = new Set(processes())
  const fixture=await launchFixture(path.join(import.meta.dir,'preview-app.fixture.ts'),{KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:path.join(scratch,`client-${tag}`),KYBERN_GPUIX_CREDENTIALS_DIR:path.join(scratch,'credentials'),KYBERN_GPUIX_THREAD:thread.id,KYBERN_APPEARANCE:appearance,KYBERN_REDUCED_MOTION:reduced,GPUIX_BACKGROUND:'1',KYBERN_PREVIEW_EVENTS:events,KYBERN_PREVIEW_TARGET:file,KYBERN_WINDOW_SIZE:'1280x820'})
  const a=fixture.app, log=()=>readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
  const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+15000;while(!predicate()){if(Date.now()>deadline)throw Error(`${label}: ${fixture.diagnostics()}\n${JSON.stringify(log())}`);await Bun.sleep(50)}}
  try{
    await a.getByTestId('dock-preview').waitFor();await wait(()=>log().some(e=>e.data?.kind==='fixture-page'),'local HTML load');await wait(()=>log().some(e=>e.data?.kind==='fixture-visual'),'visual load');await a.getByTestId('visual-expand').waitFor();await wait(()=>log().some(e=>e.data?.kind==='kybern-visual-size'),'visual layout');await Bun.sleep(100)
    const window=log().find(e=>e.type==='created').windowNumber
    await wait(()=>log().some(e=>e.data?.kind==='fixture-security'),'visual isolation')
    const security=log().find(e=>e.data?.kind==='fixture-security').data
    assert.equal(security.parentReadable,false);assert.equal(security.localFetch,'blocked');assert.equal(security.origin,'null');assert.equal(security.isolatedHandler,'undefined');assert.ok(!log().some(e=>e.data?.kind==='forged-main'),'Untrusted child forged a main-frame native message')
    const shot=(name:string)=>execFileSync('screencapture',['-l',String(window),'-x',path.join(out,`${name}-${tag}.png`)])
    shot('app-file');const pageIdentity=log().find(e=>e.data?.kind==='fixture-page').data.identity
    await a.getByTestId('preview-more').click();await a.getByTestId('preview-float').click();await a.getByTestId('preview-mini').waitFor();await Bun.sleep(500);shot('app-mini')
    await a.getByTestId('preview-mini-return').click();await a.getByTestId('preview-slot-dock').waitFor();await Bun.sleep(300)
    assert.equal(log().filter(e=>e.data?.kind==='fixture-page').length,1,'Dock / mini reloaded local document');assert.equal(log().find(e=>e.data?.kind==='fixture-page').data.identity,pageIdentity)
    // "Open in a tab" (ADE-54): the visual tab is its own web view, so it loads the document once more; ⌘1 returns to the chat.
    await a.getByTestId('visual-expand').click();await a.getByTestId('visual-tab').waitFor();await Bun.sleep(500);shot('app-visual-tab');await a.getByTestId('app-ready').press('cmd-1');await Bun.sleep(300)
    assert.equal(log().filter(e=>e.data?.kind==='fixture-visual').length,2,'The visual tab loaded its document more than once')
    await a.getByTestId('preview-address').fill(`http://127.0.0.1:${server.port}/`);await a.getByTestId('preview-address').press('enter');await wait(()=>log().some(e=>e.data?.asset===true),'localhost root assets');await Bun.sleep(300);shot('app-server')
    await a.getByTestId('preview-more').click();await a.getByTestId('preview-device').click();await a.getByTestId('preview-rotate').click();await Bun.sleep(300);shot('app-device')
    assert.equal(log().filter(e=>e.data?.asset===true).length,1,'Device toolbar reloaded server')
    if (process.env.KYBERN_PREVIEW_PERF === '1' && tag === 'dark-normal') {
      await Bun.sleep(2000)
      const webkit = processes().filter(pid=>!before.has(pid)), pids=[fixture.pid,...webkit]
      const sample = Bun.spawn(['bun',path.join(import.meta.dir,'../perf/sample.ts'),'15',`GPUIX+WebKit=${pids.join(',')}`],{stdout:'pipe',stderr:'pipe'})
      const [stdout,stderr]=await Promise.all([new Response(sample.stdout).text(),new Response(sample.stderr).text()]);assert.equal(await sample.exited,0,stderr)
      writeFileSync(path.join(out,'idle-sample.txt'),`Runtime: GPUIX 0.10.0 + standalone WKWebView companion; macOS ${execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim()}; ${execFileSync('sysctl',['-n','machdep.cpu.brand_string'],{encoding:'utf8'}).trim()}\nWorkload: full app, settled synthetic turn, inline visual + localhost device preview; after matrix interactions and 2s settle; GPUIX_BACKGROUND=1, no activation. WebKit attribution: PID difference before/after this single locked UI launch (user applications can introduce unrelated processes).\nNew WebKit PIDs: ${webkit.join(',')}\n${stdout}\n${stderr}`)
      console.log(stdout)
    }
    const previewHost=log().filter(e=>e.type==='created'&&e.id.startsWith('preview:')).at(-1)
    await a.getByTestId('preview-more').click();await a.getByTestId('preview-close').click();await wait(()=>log().some(e=>e.type==='destroyed'&&e.id===previewHost.id&&e.generation===previewHost.generation),'close removes native document')
    const visualHost=log().find(e=>e.type==='created'&&e.id.startsWith('visual:'))
    await a.getByTestId('app-ready').press('ctrl-alt-e');await wait(()=>log().some(e=>e.type==='destroyed'&&e.id===visualHost.id&&e.generation===visualHost.generation),'environment reset removes native visual')
    console.log(`PASS ${tag}: local HTML + inline visual + stable dock/mini and expanded visual + localhost/root assets + device rotate`)
  }catch(error){const window=log().find(e=>e.type==='created')?.windowNumber;if(window)execFileSync('screencapture',['-l',String(window),'-x',path.join(out,`app-failed-${tag}.png`)]);console.error(fixture.diagnostics());console.error((await a.call('getPaintedText',{})).text.join('\n'));throw error}finally{await fixture.close();const deadline=Date.now()+3000;for(;;){try{process.kill(fixture.pid,0)}catch{break}if(Date.now()>deadline)throw Error('Preview fixture did not stop before releasing UI lock');await Bun.sleep(30)}}
}}finally{server.stop(true);await client.call('threads.archive',{thread_id:thread.id});client.close()}
assert.ok(assets >= (process.env.KYBERN_PREVIEW_CASE ? 1 : 4))
}
const release = acquirePreviewUiLock()
try { await main() } finally { release() }
