import {mkdirSync,writeFileSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/transcript'
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-transcript'
mkdirSync(data,{recursive:true})
const results=[]
for(const count of [1000,3000])for(const baseline of [true,false]){
 const child=Bun.spawn(['bun',import.meta.dir+'/entry.ts'],{env:{...process.env,TRANSCRIPT_HEADLESS:'1',TRANSCRIPT_BASELINE:baseline?'1':'0',TRANSCRIPT_TURNS:String(count),KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:''},stdout:'pipe',stderr:'pipe'})
 const output=await new Response(child.stdout).text(),errors=await new Response(child.stderr).text()
 if(await child.exited)throw Error(errors)
 const result={baseline,...JSON.parse(output.trim().split('\n').at(-1)!)};results.push(result);console.log(JSON.stringify(result))
}
writeFileSync(out+'/structural-counts-final.json',JSON.stringify(results,null,2))
