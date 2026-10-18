const requested=Number(process.argv[2])
const cases = process.argv.includes('stream') ? [['baseline-final-fixed-stream',1000,true,true],['final-fixed-stream',1000,true,false]] as const : ([['baseline-final-fixed',1000,false,true],['final-fixed',1000,false,false],['baseline-final-fixed',3000,false,true],['final-fixed',3000,false,false]] as const).filter(row=>!requested||row[1]===requested)
for(const [label,count,stream,baseline] of cases){
 const child=Bun.spawn(['bun',import.meta.dir+'/run.ts',label,String(count)],{env:{...process.env,TRANSCRIPT_INPUT:'appkit',TRANSCRIPT_MATCHED:'1',TRANSCRIPT_PAIR:'1',KYBERN_TRANSCRIPT_WINDOW_BUFFER:baseline?'0':'1',KYBERN_TRANSCRIPT_SLOT_CACHE:baseline?'0':'1',KYBERN_TRANSCRIPT_LAYOUT:baseline?'0':'1',KYBERN_SCROLL_COALESCE:baseline?'0':'pr',TRANSCRIPT_STREAM:stream?'1':'0',TRANSCRIPT_SCENES:stream?'scroll':'scroll,fling,idle'},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)throw Error(label+' failed')
}
export {}
