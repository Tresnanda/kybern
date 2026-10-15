/** In-memory settings mutations; real daemon is used only for a scratch defaults read. */
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import path from 'node:path'
import {tmpdir,homedir} from 'node:os'
import {createHash} from 'node:crypto'
import {KybernClient} from '../../../../packages/kybern-client/src/client.ts'
import {PROTOCOL_VERSION} from '../../../../packages/kybern-client/src/types.ts'
import {launchFixture} from '../requests/harness.ts'
const data=process.env.KYBERN_DATA_DIR
if(!data?.includes('gpuix-scratch'))throw Error('Use scratch data')
const client=new KybernClient({url:`ws://127.0.0.1:${readFileSync(path.join(data,'daemon.port'),'utf8').trim()}/ws`,token:readFileSync(path.join(data,'daemon.token'),'utf8').trim()})
client.connect();for(let i=0;client.status!=='open'&&i<100;i++)await Bun.sleep(50)
let settings=await client.call('settings.get',{});client.close()
const scratch=mkdtempSync(path.join(tmpdir(),'gpuix-scratch-settings-'))
const bundled=path.join(scratch,'kybern'),target=path.join(scratch,'bin/kybern');writeFileSync(bundled,'fixture')
const now=new Date().toISOString()
const project={id:'fixture',name:'Fixture',path:scratch,is_git:true,created_at:now,updated_at:now}
let accounts=[{provider:{kind:'codex',instance:'work'},name:'Work',color:'blue',status:'signed_in',is_default:false,projects:[],identity:{email:'fixture@example.test'}},{provider:{kind:'codex',instance:'default'},name:'CLI account',status:'signed_in',is_default:true,projects:[]}]
let notes=[{bundle_id:'com.fixture.App',app:'Fixture app',text:'Original hint',updated_at:now}]
let cursor={sdk_version:'fixture',installed:false,installing:false,signing_in:false,account:'signed_out'}
const calls:{method:string;params:any}[]=[]
const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch(req,server){if(server.upgrade(req))return;return new Response('fixture')},websocket:{message(ws,raw){
 const {id,method,params}=JSON.parse(String(raw));calls.push({method,params});let result:any={};let error=''
 switch(method){
 case 'daemon.info':result={protocol_version:PROTOCOL_VERSION,environment_id:'settings-fixture',version:'1.0.0',hostname:'Fixture',os:'macOS',arch:'arm64',data_dir:scratch};break
 case 'projects.list':result={projects:[project]};break
 case 'threads.list':result={threads:[],activity:[]};break
 case 'providers.list':result={providers:[]};break
 case 'settings.get':result=settings;break
 case 'settings.update':settings=params.settings;result=settings;ws.send(JSON.stringify({jsonrpc:'2.0',method:'settings.changed',params:{settings}}));break
 case 'providers.accounts.list':result={accounts:accounts.map(a=>({...a,is_default:(settings.providers.codex?.default_account??'default')===a.provider.instance}))};break
 case 'providers.accounts.update':accounts=accounts.map(a=>a.provider.instance===params.instance?{...a,name:params.name,color:params.color}:a);result=accounts[0];break
 case 'providers.accounts.sign_out':accounts=accounts.map(a=>a.provider.instance===params.instance?{...a,status:'signed_out'}:a);result=accounts[0];break
 case 'providers.accounts.remove':accounts=accounts.filter(a=>a.provider.instance!==params.instance);break
 case 'events.subscribe':result={subscription_id:'fixture',head_seq:0,replay_ready:true};break
 case 'usage.limits':result={providers:[],accounts:[],refreshing:[]};break
 case 'harness_updates.list':result={updates:[]};break
 case 'cursor.status':result=cursor;break
 case 'cursor.setup':cursor={...cursor,installed:true,signing_in:params.action==='sign_in',account:params.action==='sign_out'?'signed_out':cursor.account};result=cursor;break
 case 'computer.status':case 'computer.setup':result={supported:true,installed:false,enabled:true,signed:false,ready:false,required_version:'1',accessibility:'unknown',screen_recording:'unknown',checks:[]};break
 case 'computer.notes.list':result={notes};break
 case 'computer.notes.set':notes=params.text?[{...notes[0]!,text:params.text}]:[];result={notes};break
 case 'integrations.list':result={items:[],warnings:[]};break
 case 'daemon.activity':result={live_sessions:0,idle_sessions:0,terminals:0,connections:1};break
 default:if(!['ping','events.unsubscribe'].includes(method))error=`Fixture rejects ${method}`
 }
 ws.send(JSON.stringify(error?{jsonrpc:'2.0',id,error:{code:-32000,message:error}}:{jsonrpc:'2.0',id,result}))
}}})
const mode=process.argv.includes('--light')?'light':'dark'
const out='/Users/mymac/projects/ade/previews/gpuix/p6/after';mkdirSync(out,{recursive:true})
const url=`ws://127.0.0.1:${server.port}/ws`
const artifacts=[path.join(homedir(),'Library/Application Support/kybern-gpuix',`workspace-${createHash('sha1').update(url).digest('hex').slice(0,12)}.json`),path.join(homedir(),'Library/Caches/kybern-gpuix',`providers-${url.replace(/[^a-z0-9]+/gi,'_')}.json`)].map(file=>({file,before:existsSync(file)?readFileSync(file):null}))
const f=await launchFixture(path.join(import.meta.dir,'../main.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_URL:`ws://127.0.0.1:${server.port}/ws`,KYBERN_TOKEN:'fixture',KYBERN_DATA_DIR:scratch,KYBERN_CLIENT_CONFIG_DIR:scratch,KYBERN_GPUIX_CREDENTIALS_DIR:scratch,KYBERN_APPEARANCE:mode})
const a=f.app
const click=async(id:string)=>{
 console.log('click',id);await a.getByTestId(id).waitFor({timeoutMs:10000})
 for(let i=0;i<30;i++) {
  try {const b=await a.getByTestId(id).bounds();if(b.y>=46 && b.y+b.height<800)break;await a.mouse.wheel({x:1100,y:600},0,b.y<46?200:-200)}
  catch {await a.mouse.wheel({x:1100,y:600},0,-200)}
  await Bun.sleep(150)
 }
 await a.getByTestId(id).click();await Bun.sleep(300)
}
const scroll=async(y:number)=>{await a.call('scrollTo',{elementId:(await a.getByTestId('settings-content').element()).id,x:0,y});await Bun.sleep(150)}
try{
 await a.getByTestId('app-ready').waitFor({timeoutMs:60000});await click('rail-settings');await click('settings-worktrees')
 await click('settings-global-notes');await click('settings-global-notes-separate')
 assert.equal(JSON.parse(readFileSync(path.join(scratch,'notes-preferences.json'),'utf8')).globalHome,'separate')
 // The Notes header and other windows publish through this same watched preference.
 writeFileSync(path.join(scratch,'notes-preferences.json'),JSON.stringify({globalHome:'shared'}))
 for(let i=0;i<100;i++){if((await a.getByTestId('settings-global-notes').textContent()).includes('Shared across environments'))break;await Bun.sleep(30)}
 assert.match(await a.getByTestId('settings-global-notes').textContent(),/Shared across environments/)
 await click('settings-tab-notifications');assert.match(await a.getByTestId('page-settings').textContent(), /OS notifications require the packaged Kybern GPUIX.app/);assert.equal(await a.getByTestId('settings-notification-access').count(),1)
 if(!process.argv.includes('--about-only')) { await click('settings-tab-accounts');await click('account-actions-codex-work');await click('account-actions-codex-work-edit')
 await a.getByTestId('account-edit').press('escape');await Bun.sleep(200);assert.equal(await a.getByTestId('page-settings').count(),1);assert.equal(await a.getByTestId('account-edit').count(),0);await click('account-actions-codex-work');await click('account-actions-codex-work-edit')
 await a.getByTestId('account-name').fill('Personal');await click('account-color');await click('account-color-purple');await click('account-save');assert.equal(accounts[0]!.color,'purple');assert.equal(accounts[0]!.name,'Personal')
 await click('account-actions-codex-work');await click('account-actions-codex-work-default');assert.equal(settings.providers.codex?.default_account,'work')
 await click('account-actions-codex-work');await click('account-actions-codex-work-projects');await click('account-project');await click(`account-project-${scratch}`);await click('account-project-codex');await click('account-project-codex-work');assert.equal(settings.providers.codex?.project_accounts?.[scratch],'work');await a.getByTestId('account-projects').press('escape');await Bun.sleep(200)
 await a.screenshot({path:`${out}/accounts-${mode}.png`})
 await click('account-actions-codex-work');await click('account-actions-codex-work-sign_out');await click('account-confirm-submit');assert.equal(accounts[0]!.status,'signed_out');await click('account-actions-codex-work');await click('account-actions-codex-work-remove');await click('account-confirm-submit');assert.equal(accounts.length,1)
 await click('settings-tab-computer');await scroll(1300);await click('computer-note-com.fixture.App');await a.getByTestId('computer-note-text').fill('Edited hint');await Bun.sleep(300);await click('computer-note-save');assert.equal(notes[0]!.text,'Edited hint')
 await a.screenshot({path:`${out}/computer-notes-${mode}.png`});await click('computer-setup');assert.ok(calls.some(c=>c.method==='computer.setup'&&c.params.action==='install'))
 await click('settings-tab-agents');await scroll(5000);await click('cursor-install');assert.equal(cursor.installed,true)
 await click('cursor-sign-in');assert.equal(cursor.signing_in,true);await click('cursor-cancel');assert.equal(cursor.signing_in,false)
 }
 await click('settings-tab-about');await scroll(800);await a.getByTestId('cli-bundled').fill(bundled);await a.getByTestId('cli-target').fill(target);await click('cli-check');await click('cli-install');await a.screenshot({path:`${out}/cli-result-${mode}.png`});for(let i=0;!existsSync(target)&&i<30;i++)await Bun.sleep(100);assert.ok(existsSync(target));await click('cli-install');for(let i=0;existsSync(target)&&i<30;i++)await Bun.sleep(100);assert.ok(!existsSync(target))
 await a.screenshot({path:`${out}/about-${mode}.png`})
 console.log(`PASS ${mode}: ${process.argv.includes('--about-only')?'': 'account edit/default/project/sign-out, app note save, Cursor install/sign-in/cancel, '}CLI temp symlink install/uninstall; mocked RPCs only`)
}catch(error){await a.screenshot({path:`${out}/settings-failure-${mode}.png`});console.log(await a.getByTestId('page-settings').textContent());throw error}finally{await f.close();server.stop(true);rmSync(scratch,{recursive:true,force:true});for(const {file,before} of artifacts){if(before)writeFileSync(file,before);else rmSync(file,{force:true})}}
