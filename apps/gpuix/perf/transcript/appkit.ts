import {dlopen,FFIType} from 'bun:ffi'
const wheel=dlopen(process.env.KYBERN_DATA_DIR!+'/transcript-wheel.dylib',{bench_scroll:{args:[FFIType.f64,FFIType.f64,FFIType.f64,FFIType.i32,FFIType.i32],returns:FFIType.i32}}).symbols.bench_scroll
export async function driveNative(body:{durationMs?:number;x:number;y:number;fling?:boolean;allPackets?:boolean}){
  const sent:number[]=[],start=performance.now(),count=Math.floor((body.durationMs??15000)*120/1000)
  let accepted=0,lastPhase=-1
  for(let i=0;i<count&&(body.allPackets||performance.now()-start<(body.durationMs??15000));i++){
   const tick=body.allPackets?i:Math.floor((performance.now()-start)*120/1000),phase=tick%300,cycle=tick%600,direction=cycle<300?-1:1
   const delta=body.fling?(phase<20?45:45*Math.exp(-(phase-20)/35)):(phase<120?6*Math.sin(Math.PI*Math.min(phase+1,30)/60):6*Math.exp(-(phase-120)/45))
   if(phase<lastPhase)wheel(body.x!,body.y!,0,0,3)
   if(phase>=120&&lastPhase<120)wheel(body.x!,body.y!,0,4,0)
   const contact=phase<120?(lastPhase<0||phase<lastPhase?1:2):0,momentum=phase>=120?(lastPhase<120?1:2):0
   lastPhase=phase
   sent.push(performance.now());accepted+=wheel(body.x!,body.y!,direction*delta,contact,momentum)
   const due=start+(i+1)*1000/120;if(due>performance.now())await Bun.sleep(due-performance.now())
  }
  wheel(body.x!,body.y!,0,lastPhase<120?4:0,lastPhase>=120?3:0)
  return {sent,accepted,productionMs:performance.now()-start,drainMs:0,maxOutstanding:0,acks:[],input:'120 Hz scheduled real AppKit NSEvent scrollWheel; precise deltas + native contact and momentum phases; direct own-window dispatch'}
 }
