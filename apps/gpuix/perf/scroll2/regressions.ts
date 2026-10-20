import {mkdirSync,readdirSync} from 'node:fs'
if(readdirSync('/tmp').some(name=>name.startsWith('kybern-gpuix-native-build.')))throw Error('Defer UI checks until native build completes')
const out='/Users/mymac/projects/ade/previews/gpuix/perf/scroll2/convo9';mkdirSync(out,{recursive:true})
const cases=[['src/transcript/verify-parity.ts','long'],['src/transcript/verify-parity.ts','prompt'],['src/transcript/split.verify.ts'],['src/transcript/collapse.verify.ts'],['src/transcript/reveal.verify.ts'],['src/transcript/stream9.verify.ts']]
for(const args of cases){
 const child=Bun.spawn(['bun',...args],{env:{...process.env,KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2/config',KYBERN_VERIFY_OUTPUT:out,KYBERN_PARITY_OUT:out,KYBERN_FULL_RATE:'1'},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)throw Error(`${args.join(' ')} failed`)
}
