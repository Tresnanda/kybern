import {readdirSync,watch,readFileSync,existsSync} from 'node:fs'
import path from 'node:path'
export function nativeBuildMarkers(directory='/tmp'){return readdirSync(directory).filter(name=>name.startsWith('kybern-gpuix-native-build.')).sort()}
export function quietMarkers(directory='/tmp'){return readdirSync(directory).filter(name=>name.startsWith('kybern-gpuix-quiet.')).sort()}
export function quietOrder(directory='/tmp'){
 const legacy=readdirSync(directory).filter(name=>name.startsWith('kybern-gpuix-quiet-next.')).sort().map(name=>name.slice('kybern-gpuix-quiet-next.'.length))
 let ordered:string[]=[]
 try{ordered=readFileSync(path.join(directory,'kybern-gpuix-quiet-order'),'utf8').split('\n').map(line=>line.trim()).filter(Boolean)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 return [...new Set([...legacy,...ordered])]
}
/** Normal leased runs do not reserve quiet time. Refuse to use an externally
 * created bench quiet marker out of turn; never edit another lane's queue. */
export function assertQuietTurn(lane='perf-bench',directory='/tmp'){
 if(existsSync(path.join(directory,`kybern-gpuix-quiet.${lane}`))&&quietOrder(directory)[0]!==lane)throw Error(`${lane} quiet window is out of turn; append the lane with Python to kybern-gpuix-quiet-order and wait for the first line`)
}
export function buildOverlap(before:string[],after:string[]){return before.length>0||after.length>0}

/** Watch short-lived build markers too; endpoints remain in the evidence. */
export function watchBuilds(directory='/tmp'){
 const before=nativeBuildMarkers(directory),quietBefore=quietMarkers(directory),orderBefore=quietOrder(directory),seen=new Set(before)
 const capture=()=>{for(const name of nativeBuildMarkers(directory))seen.add(name)}
 const watcher=watch(directory,(_event,file)=>{if(String(file).startsWith('kybern-gpuix-native-build.')){seen.add(String(file));capture()}})
 const timer=setInterval(capture,250)
 return {finish(){const after=nativeBuildMarkers(directory);watcher.close();clearInterval(timer);return {buildMarkersBefore:before,buildMarkersAfter:after,buildMarkersDuring:[...seen].sort(),quietMarkersBefore:quietBefore,quietMarkersAfter:quietMarkers(directory),quietOrderBefore:orderBefore,quietOrderAfter:quietOrder(directory),overlap:buildOverlap(before,after)||seen.size>0}}}
}
