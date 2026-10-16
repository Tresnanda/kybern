/** Build review crops/strips from finished captures; does not launch an app. */
import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import path from 'node:path'
import {pngPixels} from './clip-pixels.ts'
const output=process.argv[2]
if(!output)throw Error('Pass a finished normal or reduced capture directory')
const run=(command:string[])=>{const r=Bun.spawnSync(command,{stdout:'pipe',stderr:'pipe'});if(r.exitCode)throw Error(r.stderr.toString());return r.stdout.toString()}
const crop=path.join(import.meta.dir,'build/clip-crops')
run(['swiftc','-O',path.join(import.meta.dir,'clip-crops.swift'),'-o',crop])
const assertions=[]
for(const file of readdirSync(output).filter(f=>f.endsWith('-gpuix-bounds.json'))){
 const prefix=path.join(output,file.replace('-gpuix-bounds.json',''))
 if(!existsSync(prefix+'-tauri-bounds.json'))throw Error('Missing Tauri geometry: '+prefix)
 for(const app of ['tauri','gpuix']){
  const m=JSON.parse(readFileSync(prefix+`-${app}-bounds.json`,'utf8')),im=pngPixels(prefix+`-${app}.png`),scale=im.width/m.window.width
  const pixel=(x:number,y:number)=>im.at(x*scale,y*scale)
  const clear=(x:number,y:number,color:number[],label:string)=>assert.ok(pixel(x,y).every((v,i)=>Math.abs(v-color[i]!)<=5),`${prefix} ${app} ${label}: paint escaped the corner`)
  const b=m.workspace,frame=pixel(b.x-3,b.y+24)
  for(const x of [b.x+1,b.x+b.width-1])for(const y of [b.y+1,b.y+b.height-1])clear(x,y,frame,'workspace')
  if(/clip-(closed|code-horizontal|code-wrapped)-/.test(prefix)){
   const last=/code-(horizontal|wrapped)/.test(prefix),boxes=app==='tauri'?m.code:m.codeBodies,c=boxes[last?boxes.length-1:0],outside=pixel(c.x-3,c.y+c.height-1)
   clear(c.x+1,c.y+c.height-1,outside,'code bottom left');clear(c.x+c.width-1,c.y+c.height-1,outside,'code bottom right')
  }
  assertions.push({capture:path.basename(prefix),app,workspaceCorners:4,codeBottomCorners:/clip-(closed|code-horizontal|code-wrapped)-/.test(prefix)?2:0})
 }
 run([crop,prefix+'-tauri.png',prefix+'-gpuix.png',prefix+'-tauri-bounds.json',prefix+'-gpuix-bounds.json',prefix])
 // Recompose too: a reference-only rerun can update corrected endpoint bounds.
 run(['swift',path.join(import.meta.dir,'../visual/compose.swift'),prefix+'-tauri.png',prefix+'-gpuix.png',prefix+'-pair.png',prefix+'-diff.png'])
 console.log('corners/code',path.basename(prefix))
}
writeFileSync(path.join(output,'corner-assertions.json'),JSON.stringify(assertions,null,2))
for(const theme of ['dark','light']){
 const strips=[]
 for(const app of ['tauri','gpuix']){
  const base=path.join(output,`panel-${theme}-${app}`),strip=base+'-strip.png'
  const geometry=JSON.parse(readFileSync(path.join(base,'geometry.json'),'utf8')) as {time:number;composer?:{x:number};card?:{x:number}}[]
  const positions=geometry.map(g=>(g.composer??g.card)!.x),movement=Math.max(...positions)-Math.min(...positions)
  assert.ok(output.endsWith('/reduced')?movement<.1:movement>10,`${base}: actual geometry must match the motion preference`)
  run(['swift',path.join(import.meta.dir,'../scripts/shell3-strip.swift'),strip,...[0,40,80,140,220,320].map(t=>path.join(base,`t${t}.png`))])
  strips.push(strip)
 }
 run(['swift',path.join(import.meta.dir,'../visual/compose.swift'),...strips,path.join(output,`panel-${theme}-pair-strip.png`),path.join(output,`panel-${theme}-diff-strip.png`)])
 console.log('motion strip',theme)
}
