import '../../src/native/local-build.ts'
import '../../src/native/backdrop.ts'
import {render} from '@gpuix/react'
import {useState} from 'react'
const light=process.env.KYBERN_APPEARANCE==='light'
function Lab(){
 const [shift,setShift]=useState(0)
 return <div testId="app-ready" onKeyDown={e=>{if(e.key==='s')setShift(7)}} style={{width:'100%',height:'100%',backgroundColor:light?'#eeeeee':'#202020'}}>
  {[0.01,0.1,0.25,0.5,0.99,1,1.5,2,3.99,4,4.01,16].map((sigma,i)=><div key={sigma} style={{position:'absolute',left:(i%3)*210,top:Math.floor(i/3)*112+16,width:210,height:112,overflow:'hidden',borderRadius:14}}>
   {Array.from({length:24},(_,n)=><div key={n} style={{position:'absolute',left:n*11-8+shift,top:0,width:6,height:112,backgroundColor:n%3===0?'#e74f88':n%3===1?'#408ce7':'#38bc87'}}/>)}
   <text style={{position:'absolute',left:0,top:28,color:light?'#181818':'#fafafa',fontSize:15}}>Moving glyphs and high contrast edges</text>
   <div backdrop={{blur:sigma,saturation:1.4,radius:13}} style={{position:'absolute',left:8.25,top:8.5,width:185.5,height:87.25,borderRadius:13,backgroundColor:light?'rgba(245,245,245,.25)':'rgba(20,20,20,.25)'}}/>
  </div>)}
 </div>
}
render(<Lab/>,{title:'Backdrop reconstruction',width:630,height:480,titlebarTransparent:true,windowBackground:process.env.KYBERN_OPAQUE==='1'?'opaque':'blurred',focus:false})
