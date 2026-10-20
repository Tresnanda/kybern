/** Bounded native regressions under one externally acquired capture lock. */
import {mkdirSync} from 'node:fs'
const output=process.env.KYBERN_VERIFY_OUTPUT!
const commands=[
 ['bun','native/clip-check.ts'],['bun','native/explorer-motion-perf.ts'],
 ['bun','scripts/island-check.ts'],['bun','scripts/island-overlay-check.ts'],
 ['bun','native/paint-check.ts'],['bun','native/layout-check.ts'],
 ['bun','native/markdown-check.ts'],['bun','scripts/code-wrap-check.ts'],
 ['bun','scripts/native-check.ts'],['bun','native/webview-check.ts'],['bun','native/rounded-check.ts'],
]
const from=process.argv.find(a=>a.startsWith('--from='))?.slice(7)
const start=from?commands.findIndex(c=>c[1]!.includes(from)):0
if(start<0)throw Error(`Unknown starting check: ${from}`)
for(const command of commands.slice(start)){
 console.log('CHECK',command.join(' '))
 const dir=output+'/'+command[1]!.split('/').at(-1)!.replace('.ts','');mkdirSync(dir,{recursive:true})
 const child=Bun.spawn(command,{env:{...process.env,KYBERN_ROUNDED_WEBVIEW:'1',KYBERN_VERIFY_OUTPUT:dir},stdout:'inherit',stderr:'inherit'})
 const code=await child.exited;if(code!==0)process.exit(code)
}
