import {readdirSync,watch} from 'node:fs'
export function nativeBuildMarkers(directory='/tmp'){return readdirSync(directory).filter(name=>name.startsWith('kybern-gpuix-native-build.')).sort()}
export function quietMarkers(directory='/tmp'){return readdirSync(directory).filter(name=>name.startsWith('kybern-gpuix-quiet.')).sort()}
export function buildOverlap(before:string[],after:string[]){return before.length>0||after.length>0}

/** Watch short-lived build markers too; endpoints remain in the evidence. */
export function watchBuilds(directory='/tmp'){
 const before=nativeBuildMarkers(directory),quietBefore=quietMarkers(directory),seen=new Set(before)
 const capture=()=>{for(const name of nativeBuildMarkers(directory))seen.add(name)}
 const watcher=watch(directory,(_event,file)=>{if(String(file).startsWith('kybern-gpuix-native-build.')){seen.add(String(file));capture()}})
 const timer=setInterval(capture,250)
 return {finish(){const after=nativeBuildMarkers(directory);watcher.close();clearInterval(timer);return {buildMarkersBefore:before,buildMarkersAfter:after,buildMarkersDuring:[...seen].sort(),quietMarkersBefore:quietBefore,quietMarkersAfter:quietMarkers(directory),overlap:buildOverlap(before,after)||seen.size>0}}}
}
