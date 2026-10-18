import {mkdirSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/stream/regressions'
mkdirSync(out,{recursive:true})
for(const args of [['src/transcript/reveal.verify.ts'],['src/transcript/stream9.verify.ts'],['src/transcript/split.verify.ts'],['src/transcript/collapse.verify.ts'],['src/transcript/verify-parity.ts','long'],['src/transcript/verify-parity.ts','prompt']]){
 const child=Bun.spawn(['bun',...args],{env:{...process.env,KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-stream',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-stream/config',KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_FULL_RATE:'1',KYBERN_VERIFY_OUTPUT:out,KYBERN_PARITY_OUT:out},stdout:'inherit',stderr:'inherit'})
 const remove=onExit(async()=>{child.kill('SIGTERM');await child.exited})
 const code=await child.exited;remove();if(code)throw Error(`${args.join(' ')} failed`)
}
