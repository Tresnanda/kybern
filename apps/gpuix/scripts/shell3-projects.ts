/** Real pointer project reorder + restart persistence, isolated visual scratch only. */
import assert from 'node:assert/strict'
import { OUT,start,startScratch,waitUntil } from './shell3-lib.ts'
import { DATA_DIR,SCRATCH,CLIENT_DIR,CREDS_DIR } from '../visual/fixture.ts'
import { readFileSync,writeFileSync,readdirSync } from 'node:fs'
const light=process.argv.includes('--light')
let app=await startScratch({light,env:{KYBERN_REDUCED_MOTION:'1'}})
try{
 const getRows=async()=>{const root=(await app.call('getTree',{})).tree;const nodes:any[]=[];const walk=(n:any)=>{if(n?.testId?.startsWith('project-')&&n.bounds)nodes.push(n);n?.children?.forEach(walk)};walk(root);return nodes.filter(n=>n.testId!=='project-header').sort((a,b)=>a.bounds.y-b.bounds.y)}
 await waitUntil(async()=>(await getRows()).length>=2,12000,'two painted projects')
 const rows=await getRows()
 assert(rows.length>=2,'Need two visible projects')
 const top=rows[0],second=rows[1]
 // Collapse both blocks, then drag the first header below the second.
 const label=(n:any):string=>(n.text??'')+(n.children??[]).map(label).join('')
 for(const n of [top,second]){const loc=app.getByTestId(n.testId);await loc.hover();await Bun.sleep(180);await loc.click()}
 const a=await app.getByTestId(top.testId).center(),b=await app.getByTestId(second.testId).bounds()
 await app.mouse.move(a);await Bun.sleep(180);await app.mouse.down(a)
 for(let i=1;i<=24;i++){await app.mouse.move({x:a.x,y:a.y+(b.y+b.height+15-a.y)*i/24},{pressedButton:0});await Bun.sleep(12)}
 await app.mouse.up({x:a.x,y:b.y+b.height+15})
 await waitUntil(async()=>{try{return(await app.getByTestId(top.testId).bounds()).y>(await app.getByTestId(second.testId).bounds()).y}catch{return false}},8000,'project reorder')
 const file=()=>readdirSync(CLIENT_DIR).find(f=>f.startsWith('workspace-')&&f.endsWith('.json'))
 await waitUntil(async()=>!!file()&&JSON.parse(readFileSync(`${CLIENT_DIR}/${file()}`,'utf8')).projectOrder?.includes(top.testId.slice(8)),5000,'project order saved')
 const stored=JSON.parse(readFileSync(`${CLIENT_DIR}/${file()}`,'utf8'))
 assert(stored.projectOrder.indexOf(top.testId.slice(8))>stored.projectOrder.indexOf(second.testId.slice(8)))
 await app.screenshot({path:`${OUT}/projects-${light?'light':'dark'}.png`})
 writeFileSync(`${OUT}/projects-${light?'light':'dark'}.json`,JSON.stringify({before:[label(top),label(second)],after:[second.testId,top.testId],stored},null,2))
 await app.close()
 const up=JSON.parse(readFileSync(`${SCRATCH}/shell3-up.json`,'utf8'))
 app=await start(light,{KYBERN_DATA_DIR:DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:CLIENT_DIR,KYBERN_GPUIX_CREDENTIALS_DIR:CREDS_DIR,KYBERN_URL:up.proxy,KYBERN_REDUCED_MOTION:'1'})
 await waitUntil(async()=>{try{return(await app.getByTestId(top.testId).bounds()).y>(await app.getByTestId(second.testId).bounds()).y}catch{return false}},12000,'project order restored after restart')
 console.log('PASS pointer project reorder + restart',top.testId,'below',second.testId)
}finally{await app.close()}
