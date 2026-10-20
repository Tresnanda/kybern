import '../../src/native/local-build.ts'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs'
import path from 'node:path'
import {launchFixture} from '../../scripts/idle-harness.ts'
import {loadGpuixScreens, loadGpuixEntries} from '../../visual/load.ts'
import {requireScreen} from '../bench/screen-state.ts'
import {waitForWindowOnscreen,requireWindowOnscreen} from '../bench/window-onscreen.ts'
import {pixels} from '../../native/png.ts'
import type {Fixture} from '../../visual/screens.gpuix.ts'
const [theme='dark', reduced='0', ...names]=process.argv.slice(2)
// The enclosing UI lease kills this controller's process group on exit.
// Bound even a stalled automation request below the shared five-minute limit.
setTimeout(()=>{console.error('Hover audit batch exceeded 285 seconds');process.exit(124)},285_000).unref()
const out=process.env.HR5_OUT!, fixture=JSON.parse(readFileSync(process.env.HR5_FIXTURE!,'utf8')) as Fixture
const screens=await loadGpuixScreens(),entries=await loadGpuixEntries(),results=[]
for(const name of names){
 requireScreen();rmSync(path.join(process.env.KYBERN_DATA_DIR!,'gpuix-ui.json'),{force:true});rmSync(process.env.KYBERN_CLIENT_CONFIG_DIR!,{force:true,recursive:true})
 const input=path.join(process.env.VISUAL_SCRATCH!,`hover-input-${theme}-${reduced}-${name}.json`);writeFileSync(input,'{}')
 const entry=entries[name]?.entry??'perf/hover/entry.ts'
 const f=await launchFixture(path.resolve(entry),{...entries[name]?.env,HR5_INPUT:input,GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_OPAQUE:'1',KYBERN_WINDOW_SIZE:'1280x820'})
 const a=f.app, record:{surface:string;theme:string;reduced:string;checks:Record<string,unknown>}={surface:name,theme,reduced,checks:{}}
 try{
  await a.getByTestId('app-ready').waitFor({timeoutMs:60000});await waitForWindowOnscreen(f.pid)
  const prepared=crypto.randomUUID();writeFileSync(input,JSON.stringify({prepare:true,nonce:prepared}));const prepareDeadline=Date.now()+5000
  while(!existsSync(input+'.done')||JSON.parse(readFileSync(input+'.done','utf8')).nonce!==prepared){if(Date.now()>prepareDeadline)throw Error('Owned window preparation not acknowledged');await Bun.sleep(20)}
  assert.equal(JSON.parse(readFileSync(input+'.done','utf8')).accepted,1);requireWindowOnscreen(f.pid);await Bun.sleep(1200)
  if(name==='notes-editor'){
   await screens['notes-gallery']!(a,fixture)
   await a.getByTestId('notes-search').fill('Hover audit note 31');await Bun.sleep(500)
   await a.getByTestId(`note-card-${fixture.notes['Hover audit note 31']}`).click()
   await a.getByTestId('note-body').waitFor({timeoutMs:10000});await Bun.sleep(500)
  }else await screens[name]!(a,fixture)
  if(name==='conversation-helpers'||name==='thread-header'){
   const threadId=name==='conversation-helpers'?fixture.extra.conversation!['Helper review']:fixture.extra.settings!.threadId
   const row=a.getByTestId(`thread-${threadId}`)
   await a.mouse.wheel({x:200,y:600},0,5000);await Bun.sleep(250)
   let visible=false
   for(let attempt=0;attempt<30;attempt++){
    const box=await row.bounds().catch(()=>null)
    if(box&&box.y>60&&box.y+box.height<790){visible=true;break}
    await a.mouse.wheel({x:200,y:600},0,-112);await Bun.sleep(160)
   }
   assert.ok(visible,'Thread row must actually be visible before clicking')
   await row.click();await Bun.sleep(700)
  }
  if(name==='dock-explorer'){
   const folder=a.getByTestId('dock-file-src');await folder.hover();await folder.click();await Bun.sleep(500)
   await folder.click();await Bun.sleep(350);await folder.click();await Bun.sleep(500);record.checks.explorerDisclosureClicks=3
  }
  if(name==='tasks-list'){
   const groups=await a.call('getTree',{}),ids:string[]=[]
   const visit=(n:NonNullable<typeof groups.tree>)=>{if(n.testId?.startsWith('task-group-'))ids.push(n.testId);n.children?.forEach(visit)};if(groups.tree)visit(groups.tree)
   for(const id of ids){const box=await a.getByTestId(id).bounds().catch(()=>null);if(!box||box.y<50||box.y+box.height>800)continue
    const p={x:box.x+16,y:box.y+box.height/2};await a.mouse.move(p);await a.mouse.click(p);await Bun.sleep(400);await a.mouse.click(p);await Bun.sleep(400);record.checks.taskGroupDisclosureClicks=2;break
   }
   assert.equal(record.checks.taskGroupDisclosureClicks,2,'Expected task group disclosure')
  }
  const tree=(await a.call('getTree',{})).tree
  type Node=NonNullable<typeof tree>
  const nodes:Node[]=[];const walk=(n:Node)=>{nodes.push(n);n.children?.forEach(walk)};if(tree)walk(tree)
  const pref:Record<string,string>={
   'notes-list':'note-card-', 'notes-gallery':'note-card-', 'tasks-list':'task-row-', 'tasks-board':'task-drag-',
   'dock-explorer':'dock-file-src', 'dock-notes':'dock-note-', 'dock-tasks':'dock-task-',
   'settings-general':'settings-tab-appearance', 'pulls-list':'pr-row-', 'dock-add-menu':'dock-add-explorer',
   'dock-agents':'dock-tab-', 'thread-header':`thread-${fixture.extra.settings!.threadId}`, 'conversation-helpers':`thread-${fixture.extra.conversation!['Helper review']}`, 'shell-home':'project-', 'shell-new-chat-hover':'rail-notes', 'composer-home-workspace':'tray-workspace', 'draft':'composer-', 'palette':'palette-item-',
  }
  const prefix=pref[name]??''
  let target:Node|undefined
  for(const node of nodes.filter(n=>n.testId?.startsWith(prefix)&&prefix&&n.type!=='input'&&n.type!=='textarea')){
   try{const b=await a.getByTestId(node.testId!).bounds();if(b.width>24&&b.height>16&&b.y>50&&b.y+b.height<800){target=node;break}}catch{}
  }
  if(!target&&!['notes-editor','dock-explorer-file'].includes(name))throw Error(`No interactive audit target for ${name}`)
  if(name==='conversation-helpers'&&target){
   await a.getByTestId(target.testId!).hover();await Bun.sleep(200)
   const children=a.getByTestId(`children-${fixture.extra.conversation!['Helper review']}`)
   assert.equal(await children.count(),1,'Expected nested thread group disclosure')
   await children.click();await Bun.sleep(400);await children.click();await Bun.sleep(400);record.checks.nestedThreadDisclosureClicks=2
  }
  const initialBox=target?await a.getByTestId(target.testId!).bounds():null
  const point=initialBox?{x:initialBox.x+initialBox.width/2,y:initialBox.y+initialBox.height/2}:{x:700,y:420}
  record.checks.pointer=point
  await a.mouse.move(point);await Bun.sleep(1000)
  const id=execFileSync('swift',[path.resolve('src/tasks/round7-window-id.swift'),String(f.pid)],{encoding:'utf8'}).trim()
  let viewportWidth=1280
  const rejectedCaptures:{suffix:string;width:number;height:number}[]=[]
  const capture=async(suffix:string)=>{
   const file=`${out}/${name}-${theme}-${reduced}-${suffix}.png`,deadline=Date.now()+15000
   for(;;){
    requireScreen();await waitForWindowOnscreen(f.pid,10000)
    const state=requireWindowOnscreen(f.pid)
    if(state.windows.some(window=>window.onscreen&&window.width===viewportWidth&&window.height===820)){
     execFileSync('screencapture',['-x','-o','-l',id,file])
     const png=readFileSync(file),width=png.readUInt32BE(16),height=png.readUInt32BE(20)
     if(width===viewportWidth*2&&height===1640)return file
     rejectedCaptures.push({suffix,width,height});record.checks.rejectedCaptures=rejectedCaptures
    }
    assert.ok(Date.now()<deadline,`Unstable window/capture dimensions for ${name}/${suffix}`);await Bun.sleep(100)
   }
  }
  await capture('hover')
  const scrollHost:Record<string,string>={'shell-home':'thread-list','thread-header':'thread-list','conversation-helpers':'thread-list','notes-list':'notes-gallery','notes-gallery':'notes-gallery','tasks-list':'task-list','dock-explorer':'dock-file-tree','dock-notes':'dock-notes-list','dock-tasks':'dock-tasks-list','pulls-list':'pr-list'}
  let boardScrollId:number|undefined
  if(name==='tasks-board'&&target&&tree){
   const find=(node:Node,ancestors:Node[])=>{if(node.id===target!.id)boardScrollId=[...ancestors].reverse().find(parent=>parent.type==='virtual-list')?.id;node.children?.forEach(child=>find(child,[...ancestors,node]))}
   find(tree,[]);assert.ok(boardScrollId,'Expected the real board column scroll host')
  }
  // Resolve from the tree already read before parking the pointer. Locator
  // queries call getAutomationTree(), which requests a repaint; querying after
  // the wheel could accidentally repair the very stale hover being tested.
  const scrollElementId=boardScrollId??(scrollHost[name]?nodes.find(node=>node.testId===scrollHost[name])?.id:undefined)
  if(scrollHost[name])assert.ok(scrollElementId,`Missing scroll host for ${name}`)
  const scrolls=scrollElementId!==undefined
  const readScroll=async()=>{
   const nonce=crypto.randomUUID()
   writeFileSync(input,JSON.stringify({scroll:scrollElementId,nonce}));const end=Date.now()+5000
   while(!existsSync(input+'.done')||JSON.parse(readFileSync(input+'.done','utf8')).nonce!==nonce){if(Date.now()>end)throw Error('Scroll query not acknowledged');await Bun.sleep(20)}
   return JSON.parse(readFileSync(input+'.done','utf8')).offset
  }
  const scrollBefore=scrolls?await readScroll():undefined
  const wheelDelta=scrollBefore?.slice(0,2).some((n:number)=>Math.abs(n)>0)?112:-112
  record.checks.wheelDelta=wheelDelta
  await a.mouse.wheel(point,0,wheelDelta);await Bun.sleep(1000)
  if(scrolls){
   const scrollAfter=await readScroll();assert.ok(scrollBefore&&scrollAfter,`Expected native scroll state for ${name}`)
   assert.notDeepEqual(scrollAfter.slice(0,2),scrollBefore.slice(0,2),`${name}: wheel must move real overflowing content`)
   record.checks.scrollOffsetBefore=scrollBefore;record.checks.scrollOffsetAfter=scrollAfter
  }
  const still=await capture('stationary-scroll')
  await a.mouse.move({x:point.x+.1,y:point.y});await Bun.sleep(200)
  const nudged=await capture('nudged'),before=pixels(still),after=pixels(nudged),scale=before.w/1280
  // A tiny real move is the oracle for the post-layout hit test. Restrict the
  // comparison to the row background at the trailing edge (no caret/elapsed text).
  const b=initialBox
  let difference=0,samples=0
  if(b)for(let y=Math.max(50,b.y+5);y<Math.min(800,b.y+b.height-5);y++)for(let x=b.x+b.width-11;x<b.x+b.width-8;x++){
   const p=before.at(x*scale,before.h-820*scale+y*scale),q=after.at(x*scale,after.h-820*scale+y*scale);samples++;if(p.some((v,i)=>Math.abs(v-q[i]!)>3))difference++
  }
  record.checks={...record.checks,target:target?.testId??null,stationaryScrollBackgroundDifference:difference,sampledPixels:samples}
  if(process.env.HR5_SOURCE!=='before')assert.equal(difference,0,`${name}: hover changed only after a mouse move`)
  // Resize the real NSWindow while the native cursor stays parked. Reflow is
  // compared against the same tiny mouse-move oracle before any click changes pages.
  const nonce=crypto.randomUUID();writeFileSync(input,JSON.stringify({resize:[1180,820,point.x,point.y],nonce}));const deadline=Date.now()+5000
  while(!existsSync(input+'.done')||JSON.parse(readFileSync(input+'.done','utf8')).nonce!==nonce){if(Date.now()>deadline)throw Error('AppKit resize not acknowledged');await Bun.sleep(20)}
  assert.equal(JSON.parse(readFileSync(input+'.done','utf8')).accepted,1);await Bun.sleep(1000)
  viewportWidth=1180
  const reflowStill=pixels(await capture('stationary-reflow'));await a.mouse.move({x:point.x+.2,y:point.y});await Bun.sleep(200)
  const reflowMoved=pixels(await capture('reflow-nudged')),reflowScale=reflowStill.w/1180
  let reflowDifference=0
  if(b)for(let y=Math.max(50,b.y+5);y<Math.min(800,b.y+b.height-5);y++)for(let x=Math.min(1165,b.x+b.width-11);x<Math.min(1168,b.x+b.width-8);x++){
   const p=reflowStill.at(x*reflowScale,reflowStill.h-820*reflowScale+y*reflowScale),q=reflowMoved.at(x*reflowScale,reflowMoved.h-820*reflowScale+y*reflowScale)
   if(p.some((v,i)=>Math.abs(v-q[i]!)>3))reflowDifference++
  }
  record.checks.stationaryReflowBackgroundDifference=reflowDifference
  if(process.env.HR5_SOURCE!=='before')assert.equal(reflowDifference,0,`${name}: reflow hover changed only after a mouse move`)
  await a.call('clearSelection',{})
  if(target){
   let live=await a.getByTestId(target.testId!).bounds().catch(()=>null)
   if(!live||live.y<50||live.y+live.height>800){
    const current=(await a.call('getTree',{})).tree,currentNodes:Node[]=[]
    const collect=(n:Node)=>{currentNodes.push(n);n.children?.forEach(collect)};if(current)collect(current)
    for(const node of currentNodes.filter(n=>n.testId?.startsWith(prefix)&&prefix)){
     const box=await a.getByTestId(node.testId!).bounds().catch(()=>null)
     if(box&&box.width>24&&box.height>16&&box.y>50&&box.y+box.height<800){target=node;live=box;break}
    }
   }
   if(live&&live.y>50&&live.y+live.height<800){
    record.checks.clickTarget=target.testId
    const p={x:live.x+Math.min(live.width/2,80),y:live.y+live.height/2}
    await a.mouse.move(p);const nonce=crypto.randomUUID();writeFileSync(input,JSON.stringify({...p,count:2,nonce}));
    const deadline=Date.now()+5000
    while(!existsSync(input+'.done')||JSON.parse(readFileSync(input+'.done','utf8')).nonce!==nonce){if(Date.now()>deadline)throw Error('AppKit click was not acknowledged');await Bun.sleep(20)}
    record.checks.nativeDoubleClickAccepted=JSON.parse(readFileSync(input+'.done','utf8')).accepted;assert.equal(record.checks.nativeDoubleClickAccepted,1);await Bun.sleep(400)
    record.checks.doubleClickSelection=(await a.call('getSelectedText',{})).text
    if(process.env.HR5_SOURCE!=='before')assert.ok(!record.checks.doubleClickSelection,`${name}: double click selected interactive text`)
    await a.mouse.down(p);await a.mouse.move({x:p.x+3,y:p.y},{pressedButton:0});await a.mouse.up({x:p.x+3,y:p.y});await a.mouse.click(p);await a.mouse.click(p);await Bun.sleep(400)
    const selection=(await a.call('getSelectedText',{})).text
    record.checks.fastClicksSelection=selection
    if(process.env.HR5_SOURCE!=='before')assert.ok(!selection,`${name}: interactive text selected: ${selection}`)
   }else throw Error(`No visible click target after scroll on ${name}`)
  }
  if(name==='composer-home-workspace'){
   const chips=[]
   for(const id of ['tray-project','tray-workspace','tray-branch']){
    await a.getByTestId('app-ready').press('escape');await Bun.sleep(150)
    const box=await a.getByTestId(id).bounds(),point={x:box.x+box.width/2,y:box.y+box.height/2}
    await a.mouse.move(point);await Bun.sleep(180)
    const nonce=crypto.randomUUID();writeFileSync(input,JSON.stringify({...point,count:2,nonce}));const end=Date.now()+5000
    while(!existsSync(input+'.done')||JSON.parse(readFileSync(input+'.done','utf8')).nonce!==nonce){if(Date.now()>end)throw Error('Chip AppKit click not acknowledged');await Bun.sleep(20)}
    assert.equal(JSON.parse(readFileSync(input+'.done','utf8')).accepted,1);await Bun.sleep(400)
    const selected=(await a.call('getSelectedText',{})).text;chips.push({id,selected})
    if(process.env.HR5_SOURCE!=='before')assert.ok(!selected,`${id}: selected interactive text`)
   }
   record.checks.chips=chips
  }
  if(name==='shell-home'){
   let touched=0
   for(const node of nodes.filter(n=>/^project-[0-9a-f]{8}-/.test(n.testId??''))){
    const row=await a.getByTestId(node.testId!).bounds().catch(()=>null)
    if(!row||row.y<80||row.y+row.height>790)continue
    const p={x:row.x+16,y:row.y+row.height/2};await a.mouse.move(p);await Bun.sleep(180)
    await a.mouse.click(p);await Bun.sleep(350);await a.mouse.click(p);await Bun.sleep(350);touched++
   }
   await a.mouse.move({x:1250,y:800});await Bun.sleep(900)
   const afterLeave=(await a.call('getTree',{})).tree
   const remaining:string[]=[];const collect=(node:NonNullable<typeof afterLeave>)=>{if(node.testId?.startsWith('project-toggle-'))remaining.push(node.testId);node.children?.forEach(collect)};if(afterLeave)collect(afterLeave)
   const lingering=remaining.length
   record.checks.remainingProjectControls=remaining
   record.checks.projectDisclosureClicks=touched*2;record.checks.projectHoverAfterLeave=lingering
   if(process.env.HR5_SOURCE!=='before')assert.equal(lingering,0,'Project control remains after pointer left')
  }
  if(name==='notes-editor'){
   const editor=a.getByTestId('note-body');await editor.click();await editor.press('cmd-a');await Bun.sleep(150)
   const nonce=crypto.randomUUID();writeFileSync(input,JSON.stringify({editor:(await editor.element()).id,nonce}));const deadline=Date.now()+5000
   while(!existsSync(input+'.done')||JSON.parse(readFileSync(input+'.done','utf8')).nonce!==nonce){if(Date.now()>deadline)throw Error('Editor selection query not acknowledged');await Bun.sleep(20)}
   const selection=JSON.parse(readFileSync(input+'.done','utf8')).selection
   assert.ok(selection&&JSON.stringify(selection.anchor)!==JSON.stringify(selection.head),'Notes editor must retain native text selection')
   record.checks.editorSelection=selection
  }
  if(name==='dock-explorer-file'){
   const code=await a.getByTestId('dock-code-chunk-0').bounds()
   await a.mouse.drag({x:code.x+65,y:code.y+24},{x:code.x+165,y:code.y+24});await Bun.sleep(100)
   record.checks.codeSelection=(await a.call('getSelectedText',{})).text;assert.ok(record.checks.codeSelection,'Explorer code must remain selectable')
   assert.ok((await a.call('getPaintedText',{})).text.join('\n').includes('export const example'),'Source code content must stay visible')
  }
  await capture('clicked')
 }catch(error){record.checks.error=String(error);record.checks.diagnostics=f.diagnostics();console.error(name,error,f.diagnostics())}finally{await f.close();results.push(record);writeFileSync(`${out}/audit-${theme}-${reduced}-${names[0]}.json`,JSON.stringify(results,null,2))}
}
console.log(JSON.stringify(results))
if(results.some(r=>r.checks.error))process.exitCode=1
