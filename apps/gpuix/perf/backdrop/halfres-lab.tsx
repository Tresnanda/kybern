// Dense text under wide scene backdrops (N2). halfres-check.ts renders this with
// KYBERN_BACKDROP_HALFRES=0 and 1 and compares the filtered cells.
import '../../src/native/local-build.ts'
import '../../src/native/backdrop.ts'
import {render} from '@gpuix/react'
const light=process.env.KYBERN_APPEARANCE==='light'
const CELLS=[{blur:4,x:10,y:10},{blur:6,x:320,y:10},{blur:16,x:10,y:210},{blur:18,x:320,y:210}] as const
const line='The quick brown fox jumps over 13 lazy dogs; 0123456789 {}[]()<>/\\|#@&% WMQgjpy'
const colors=light?['#151515','#c8263b','#1d5fd1','#0f7a4f']:['#f4f4f4','#ff6b81','#6ea8ff','#52d69a']
function Lab(){
 return <div testId="app-ready" style={{width:'100%',height:'100%',backgroundColor:light?'#f1f1f1':'#1c1c1c'}}>
  {Array.from({length:42},(_,n)=><text key={n} style={{position:'absolute',left:-((n*17)%40),top:n*10,color:colors[n%4],fontSize:n%3===0?11:9,lineHeight:10,whiteSpace:'nowrap'}}>{line+' '+line}</text>)}
  {Array.from({length:12},(_,n)=><div key={'b'+n} style={{position:'absolute',left:n*53,top:0,width:3,height:420,backgroundColor:n%2?'#e74f88':'#408ce7'}}/>)}
  {process.env.KYBERN_HALFRES_SOURCE!=='1'&&CELLS.map(c=><div key={c.blur} testId={`cell-${c.blur}`} backdrop={{blur:c.blur,saturation:1.25,radius:14}} style={{position:'absolute',left:c.x,top:c.y,width:300,height:190,borderRadius:14}}/>)}
 </div>
}
render(<Lab/>,{title:'Backdrop half resolution',width:630,height:410,windowBackground:'opaque',focus:false})
