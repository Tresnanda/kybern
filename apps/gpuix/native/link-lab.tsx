import '../src/native/local-build.ts'
import {render} from '@gpuix/react'
import {useState} from 'react'
import {THEMES} from '../src/theme.ts'
import {markdownTheme} from '../src/transcript/kit.tsx'
const t=THEMES[process.env.KYBERN_APPEARANCE==='light'?'light':'dark'],base=markdownTheme(t)
const source='[Link alpha](https://example.com/one) and [Link beta](https://example.com/two)'
function Lab(){const [clicked,setClicked]=useState('No link clicked');return <div testId="ready" style={{width:'100%',height:'100%',backgroundColor:t.surface,padding:24,display:'flex',flexDirection:'column',gap:20}}>
{(['none','always','hover'] as const).map(mode=><div key={mode} style={{display:'flex',flexDirection:'column',gap:6}}><text style={{color:t.text,fontSize:14}}>{`Underline: ${mode}`}</text><markdown testId={mode} source={source} theme={{...base,markdown:{...base.markdown,link:{color:'#368ded',underline:mode,weight:500}}}} onLinkClick={e=>setClicked(e.value??'')} style={{width:600,userSelect:'text'}}/></div>)}
<markdown testId="mixed" source={'Mixed `code` [link](https://example.com/mixed) and prose.'} theme={{...base,markdown:{...base.markdown,link:{color:'#e36344',underline:'hover',weight:700}}}} onLinkClick={e=>setClicked(e.value??'')} style={{width:600,userSelect:'text'}}/>
<text testId="clicked" style={{color:t.text,fontSize:14}}>{clicked}</text>
</div>}
render(<Lab/>,{title:'Markdown link styles',width:728,height:420,focus:false})
