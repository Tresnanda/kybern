import {readFileSync} from 'node:fs'
export const resourceFile='/Users/mymac/projects/ade/previews/gpuix/round8/loops/resources.jsonl'
export function resourceRows():Record<string,any>[] {
 return readFileSync(resourceFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
}
/** Old diagnostic formatters could interleave before the visibility prefix.
 * Normalize only that prefix; preserve raw records and their original flags. */
export function usable(row:Record<string,any>):boolean {
 const events=row.visibility as {line:string}[]|undefined
 if(row.regionErrors?.length)return false
 if(row.buildFree!==true||!events||events.length<100)return false
 const states=events.map(event=>event.line.match(/\[loops-visibility\] visible=\d+ state=\d+ minimized=\d+ windows=\d+/)?.[0])
 if(states.some(state=>!state?.includes('visible=1'))||new Set(states).size!==1)return false
 return row.configuration?.nativePaint==='0'||!['thread','home-running','tasks'].includes(row.scene)||row.frames/(row.seconds*60)>.95
}
