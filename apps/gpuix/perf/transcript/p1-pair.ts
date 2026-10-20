const count=Number(process.argv[2]??1000),stream=process.argv[3]==='stream'
for(const [label,layout,coalesce] of [['baseline-final','0','0'],['rows','0','0'],['cache','1','0'],['coalesced','1','pr']]){
 const child=Bun.spawn(['bun',import.meta.dir+'/run.ts',`${label!.startsWith('baseline')?'':'p1-'}${label}${stream?'-stream':''}`,String(count)],{env:{...process.env,TRANSCRIPT_PAIR:'1',KYBERN_TRANSCRIPT_WINDOW_BUFFER:'0',KYBERN_TRANSCRIPT_SLOT_CACHE:'0',TRANSCRIPT_SCENES:stream?'scroll':label==='baseline-final'?'scroll,fling':'scroll,fling,idle',TRANSCRIPT_STREAM:stream?'1':'0',KYBERN_TRANSCRIPT_LAYOUT:layout!,KYBERN_SCROLL_COALESCE:coalesce!},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)throw Error(`${label} failed`)
}
export {}
