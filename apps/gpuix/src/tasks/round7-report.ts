import {readdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import path from 'node:path'
const out='/Users/mymac/projects/ade/previews/gpuix/round7/tasks'
const rows=[]
for(const theme of ['dark','light'])for(const reduced of [false,true]){
 const label=`${theme}-${reduced?'reduced':'normal'}-1280`,dir=`${out}/${label}-pacing`
 const files=readdirSync(dir).sort()
 const read=(file:string)=>({file,...JSON.parse(readFileSync(`${dir}/${file}`,'utf8'))})
 const board=files.filter(f=>f.startsWith('tasks-board-')).slice(-3).map(read)
 const list=files.filter(f=>f.startsWith('tasks-list-')).slice(-3).map(read)
 const project=read(files.filter(f=>f.startsWith('projects-')).at(-1)!)
 const ref=JSON.parse(readFileSync(`${out}/${label}-tauri-pacing.json`,'utf8'))
 rows.push({label,boardCarry:board[0],boardCapture:board[1],boardEdge:board[2],listCarry:list[0],listCapture:list[1],listEdge:list[2],project,reference:ref})
}
const comparison=[]
for(const theme of ['dark','light'])for(const reduced of ['0','1']){
 const label=`carry-${theme}-${reduced}`,dir=`${out}/${label}-pacing`
 if(!existsSync(dir))continue
 const files=readdirSync(dir).sort(),read=(prefix:string)=>{const file=files.filter(f=>f.startsWith(prefix)).at(-1);return file?{file,...JSON.parse(readFileSync(`${dir}/${file}`,'utf8'))}:null}
 comparison.push({label,board:read('tasks-board-'),list:read('tasks-list-'),project:read('projects-')})
}
writeFileSync(`${out}/carry-comparison.json`,JSON.stringify({kind:'Identical120-move screenshot-free8ms input loops; native changed-bounds notifications, not display presents',comparison},null,2))
const contaminated=readdirSync(`${out}/before-pacing`).map(f=>({file:f,...JSON.parse(readFileSync(`${out}/before-pacing/${f}`,'utf8'))})).filter(f=>f.max>500)
writeFileSync(`${out}/measurements.json`,JSON.stringify({runtime:'Apple M1, macOS 27.0.1, Bun 1.4.0, GPUIX 0.10.0; copied round7 addon',kind:'Native bounds notifications and WebKit rAF, not display presentation or energy',contaminatedBaselineRuns:contaminated.length,contaminated,manualClockControl: {note:'Earlier matrix used clock.fastForward waits. Those runs are retained as diagnostics, not live-clock performance. Dedicated fresh-process reintroduction reproduces the ~34ms project delay while real-clock carry is ~13ms, without production changes.', files:['project-manual-clock-pacing','project-straight-0-pacing','project-straight-1-pacing']},comparison,rows},null,2))
for(const theme of ['dark','light'])for(const reduced of [false,true])for(const width of [1280,1920]){
 const label=`${theme}-${reduced?'reduced':'normal'}-${width}`
 for(const state of ['board','quick','board-save','list-save']){
  const reference=`${out}/${label}-tauri-${state}.png`,native=`${out}/${label}-${state}.png`
  if(!existsSync(reference)||!existsSync(native))continue
  const result=Bun.spawnSync(['swift','visual/compose.swift',reference,native,`${out}/${label}-pair-${state}.png`,`${out}/${label}-diff-${state}.png`],{stdout:'pipe',stderr:'pipe'})
  if(result.exitCode)throw Error(result.stderr.toString())
 }
 if(width===1280){
  for(const kind of ['carry','cancel','drop']){
   const names=kind==='carry'?['move-1','move-10','move-30','move-60']:kind==='cancel'?['cancel-0','cancel-80','cancel-160','cancel-300']:['drop-0','drop-80','drop-160','drop-300']
   const source=kind==='drop'?'drop':'drag'
   const top=names.map(name=>`${out}/${label}-tauri-${source}/${name}.png`)
   const bottom=names.map(name=>`${out}/${label}-board-${name}.png`)
   if([...top,...bottom].some(file=>!existsSync(file)))continue
   const r=Bun.spawnSync(['swift',path.resolve('src/tasks/round7-strip.swift'),`${out}/${label}-strip-${kind}.png`,...top,...bottom],{stdout:'pipe',stderr:'pipe'})
   if(r.exitCode)throw Error(r.stderr.toString())
  }
 }
}
console.log(rows.map(row=>({mode:row.label,board:row.boardCarry&&[row.boardCarry.p50,row.boardCarry.p95],list:row.listCarry&&[row.listCarry.p50,row.listCarry.p95],project:[row.project.p50,row.project.p95],reference:[row.reference.p50,row.reference.p95]})))

console.log('normalized carry',comparison.map(row=>({mode:row.label,board:row.board&&[row.board.p50,row.board.p95],list:row.list&&[row.list.p50,row.list.p95],project:row.project&&[row.project.p50,row.project.p95]})))
