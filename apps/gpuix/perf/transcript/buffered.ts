for(const [label,count,stream,buffer] of [['appkit-buffered',3000,false,'1'],['baseline-fixed-appkit-stream',1000,true,'0'],['appkit-buffered-fixed-stream',1000,true,'1']] as const){
 const baseline=label.startsWith('baseline')
 const child=Bun.spawn(['bun',import.meta.dir+'/run.ts',label,String(count)],{env:{...process.env,TRANSCRIPT_MATCHED:stream?'1':'0',TRANSCRIPT_INPUT:'appkit',TRANSCRIPT_PAIR:'1',KYBERN_TRANSCRIPT_WINDOW_BUFFER:buffer,KYBERN_TRANSCRIPT_SLOT_CACHE:baseline?'0':'1',TRANSCRIPT_SCENES:stream?'scroll':'scroll,fling,idle',TRANSCRIPT_STREAM:stream?'1':'0',KYBERN_TRANSCRIPT_LAYOUT:baseline?'0':'1',KYBERN_SCROLL_COALESCE:baseline?'0':'pr'},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)throw Error('Buffered window comparison failed')
}
export {}
