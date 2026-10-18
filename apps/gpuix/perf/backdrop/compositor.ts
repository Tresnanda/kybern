// Accepted surface reference: task-owned headed WebKit window, not page snapshots.
import {mkdirSync,writeFileSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
import {requireScreen,keepDisplayAwake} from '../bench/screen-state.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/compositor-reference'
mkdirSync(out,{recursive:true});const before=requireScreen(),stop=keepDisplayAwake()
const server=Bun.spawn(['pnpm','exec','vite','--config','perf/backdrop/compositor.config.mjs'],{stdout:'ignore',stderr:'inherit'})
const cleanup=onExit(async()=>{server.kill();await server.exited})
let child:ReturnType<typeof Bun.spawn>|undefined
try{
 let ready=false;for(let n=0;n<100;n++){try{ready=(await fetch('http://127.0.0.1:14379/surface-webkit.html')).ok;if(ready)break}catch{}await Bun.sleep(100)}
 if(!ready)throw Error('Reference Vite did not start')
 child=Bun.spawn(['node','perf/backdrop/compositor-reference.mjs'],{stdout:'inherit',stderr:'inherit'})
 const unchild=onExit(async()=>{child?.kill();await child?.exited});const code=await child.exited;unchild();if(code)throw Error('Compositor reference failed')
 writeFileSync(out+'/screen-state.json',JSON.stringify({before,after:requireScreen()},null,2))
}finally{child?.kill();server.kill();await server.exited;cleanup();stop()}
