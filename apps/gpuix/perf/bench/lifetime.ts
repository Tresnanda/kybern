// Dispose only children and locks registered by this benchmark process.
const disposers=new Set<()=>void|Promise<void>>()
export function onExit(dispose:()=>void|Promise<void>){disposers.add(dispose);return()=>disposers.delete(dispose)}
let ending=false
async function stop(code:number){if(ending)return;ending=true;const force=setTimeout(()=>process.exit(code),4000);for(const dispose of [...disposers].reverse()){try{await dispose()}catch{}}clearTimeout(force);process.exit(code)}
process.once('SIGINT',()=>void stop(130));process.once('SIGTERM',()=>void stop(143))
