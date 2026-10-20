/** A short final reference/check batch after releasing the main capture hold. */
export {}
const root=process.env.KYBERN_VERIFY_OUTPUT!
const names=['clip-sidebar-dock','clip-sidebar','clip-dock','clip-closed','clip-split','clip-narrow','clip-code-horizontal','clip-code-wrapped','clip-panel-motion']
async function run(command:string[],env:Record<string,string>){
 const child=Bun.spawn(command,{env:{...process.env,...env},stdout:'inherit',stderr:'inherit'})
 const code=await child.exited;if(code!==0)throw Error(`${command.join(' ')} exited ${code}`)
}
// Endpoint metadata must be collected after CSS transitions and highlighting.
// Native screenshots already exist; these reference-only reruns are bounded.
if(process.argv.includes('--code')){
 for(const reduced of ['0','1']){
  const out=root+(reduced==='1'?'/reduced':'/normal')
  await run(['bun','scripts/visual-pair.ts','clip-code-horizontal','clip-code-wrapped','--theme','both','--out',out,'--keep','--tauri-only'],{KYBERN_REDUCED_MOTION:reduced,KYBERN_VERIFY_OUTPUT:out})
 }
}else if(process.argv.includes('--panel')){
 for(const reduced of ['0','1']){
  const out=root+(reduced==='1'?'/reduced':'/normal')
  await run(['bun','scripts/visual-pair.ts','clip-panel-motion','--theme','both','--out',out,'--keep'],{KYBERN_REDUCED_MOTION:reduced,KYBERN_VERIFY_OUTPUT:out})
 }
}else{
 await run(['bun','scripts/visual-pair.ts',...names,'--theme','both','--out',root+'/normal','--keep','--tauri-only'],{KYBERN_REDUCED_MOTION:'0',KYBERN_VERIFY_OUTPUT:root+'/normal'})
 await run(['bun','native/clip-validation.ts','--from=webview-check'],{KYBERN_VERIFY_OUTPUT:root+'/validation'})
}
