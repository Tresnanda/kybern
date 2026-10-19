import {execFileSync} from 'node:child_process'
export function requireWindow(pid:number) {
 const guard=process.env.KYBERN_WINDOW_GUARD
 if(guard)execFileSync(guard,['--pid',String(pid)],{stdio:'pipe'})
}
export async function waitForWindow(pid:number) {
 const deadline=Date.now()+90000
 for(;;){const probe=process.env.KYBERN_BUILTIN_DISPLAY_PROBE;if(probe)execFileSync(probe,[],{stdio:'pipe'});try{requireWindow(pid);return}catch(error){if(Date.now()>=deadline)throw error;await Bun.sleep(1000)}}
}
