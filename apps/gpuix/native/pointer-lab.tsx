import '../src/native/local-build.ts'
import {render} from '@gpuix/react'
import {useState} from 'react'
const light=process.env.KYBERN_APPEARANCE==='light',fg=light?'#202020':'#eeeeee'
function Lab(){
 const [clicks,setClicks]=useState(0),[hover,setHover]=useState(false),[enters,setEnters]=useState(0),[overlay,setOverlay]=useState(false),[overlayClicks,setOverlayClicks]=useState(0),[behind,setBehind]=useState(0)
 return <div testId="app-ready" style={{width:'100%',height:'100%',padding:24,backgroundColor:light?'#fafafa':'#202020'}}>
  <div testId="parent" onMouseEnter={()=>{setHover(true);setEnters(n=>n+1)}} onMouseLeave={()=>setHover(false)} onClick={()=>setClicks(n=>n+1)} style={{width:280,height:56,padding:8,backgroundColor:light?'#ddd':'#333',hover:{backgroundColor:light?'#ccc':'#444'}}}>
   <div cache style={{width:240,height:36}}><div testId="filled-child" style={{width:240,height:36,backgroundColor:hover?'#448855':'#665599'}}><text style={{color:'#fff'}}>Filled child inside clickable parent</text></div></div>
  </div>
  <text testId="result" style={{color:fg}}>{`Clicks ${clicks}; hover ${hover}; enters ${enters}`}</text>
  <div testId="show-overlay" onClick={()=>setOverlay(v=>!v)} style={{width:160,height:32,backgroundColor:'#665599'}}><text style={{color:'#fff',pointerEvents:'none'}}>Toggle overlay</text></div>
  <div style={{position:'relative',width:280,height:100}}>
   <div testId="behind" onClick={()=>setBehind(n=>n+1)} style={{position:'absolute',left:0,top:0,width:280,height:80,backgroundColor:'#885544'}}><text style={{color:'#fff',pointerEvents:'none'}}>Behind</text></div>
   <div testId="sibling-cover" style={{position:'absolute',left:0,top:0,width:100,height:80,backgroundColor:'#446688'}}/>
   {overlay&&<anchored position={{x:0,y:0}} deferred><div testId="overlay" onClick={()=>setOverlayClicks(n=>n+1)} style={{width:240,height:80,backgroundColor:'#444477'}}><text style={{color:'#fff'}}>Overlay</text></div></anchored>}
  </div>
  <text testId="overlay-result" style={{color:fg}}>{`Behind ${behind}; overlay ${overlayClicks}`}</text>
  <div testId="park" style={{width:100,height:32}}/>
 </div>
}
render(<Lab/>,{title:'Native pointer routing verification',width:440,height:360,focus:false})
