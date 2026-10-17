import "../src/native/local-build.ts"
import path from "node:path"
import {launchFixture} from "../src/requests/harness.ts"
for(const run of [1,2]){
 const f=await launchFixture(path.join(import.meta.dir,"surface-lab.tsx"),{GPUIX_BACKGROUND:"1",SURFACE_PERF_LEGACY:"1"})
 let scrolling:ReturnType<typeof setInterval>|undefined,busy=false
 try{
 await f.app.getByTestId("ready").waitFor()
 if(run===2){let n=0;scrolling=setInterval(()=>{if(busy)return;busy=true;f.app.mouse.wheel({x:100,y:470},0,++n%160<80?-9:9).finally(()=>busy=false)},33)}
 const sample=async(s:number,quiet=false)=>{const p=Bun.spawn(["bun",path.join(import.meta.dir,"../perf/sample.ts"),String(s),`${process.argv[2]} ${run===1?"idle":"scrolling"}=${f.pid}`],{stdout:quiet?"ignore":"inherit",stderr:"inherit"});if(await p.exited)throw Error("sample failed")}
 await sample(10,true);await sample(15)
 }finally{if(scrolling)clearInterval(scrolling);await f.close()}
}
