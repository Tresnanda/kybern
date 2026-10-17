import '../src/native/local-build.ts'
import '../src/native/backdrop.ts'
import {render} from '@gpuix/react'
const off=process.env.FILTER_OFF==='1'
const filter=(blur=8,saturation=1,radius=20)=>off?undefined:{blur,saturation,radius}
render(<div testId="ready" style={{width:'100%',height:'100%',position:'relative',backgroundColor:'#101010'}}>
{Array.from({length:73},(_,i)=><div key={i} style={{position:'absolute',left:i*10,top:0,width:10,height:500,backgroundColor:i%2?'#0044ff':'#ff2200'}}/>)}
<div testId="ordinary" backdrop={filter()} style={{position:'absolute',left:80,top:60,width:160,height:100,borderRadius:20}}/>
<div style={{position:'absolute',left:300,top:60,width:100,height:100,overflow:'hidden'}}><div backdrop={filter()} style={{position:'absolute',left:40,top:0,width:160,height:100}}/></div>
<div testId="hidden" backdrop={filter()} style={{position:'absolute',left:80,top:200,width:160,height:100,opacity:0}}/>
<div testId="saturation" backdrop={filter(0,0,0)} style={{position:'absolute',left:300,top:200,width:160,height:100}}/>
<div style={{position:'absolute',left:80,top:350,width:160,height:100}}><div cache style={{width:160,height:100}}><div backdrop={filter()} style={{width:160,height:100}}/></div></div>
<div backdrop={off?undefined:{blur:8,radius:0,fadeTop:0.5}} style={{position:'absolute',left:500,top:200,width:160,height:100}}/>
</div>,{title:'Filter geometry',width:728,height:500,focus:false})
