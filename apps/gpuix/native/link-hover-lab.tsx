import '../src/native/local-build.ts'
import {render} from '@gpuix/react'
import {useState} from 'react'
import {THEMES} from '../src/theme.ts'
import {markdownTheme} from '../src/transcript/kit.tsx'
// A multi-word link in a paragraph with inline code (mixed-size inline flow,
// one fragment per word) that wraps onto two lines, a code-span file link, and
// the same link without inline code (single text run) as the control.
const t=THEMES[process.env.KYBERN_APPEARANCE==='light'?'light':'dark'],theme=markdownTheme(t)
const issue='[#53 Scale to thousands of invitations: Cloudflare, media on R2, Premium subdomains](https://github.com/example/everlace/issues/53)'
const sources={
 flow:`${issue} is tracked with \`launch\` work.`,
 code:'Edited [`src/dashboard/UnlockPremium.tsx`](src/dashboard/UnlockPremium.tsx) and `notes.md` today.',
 plain:`${issue} is tracked with launch work.`,
}
function Lab(){const [clicked,setClicked]=useState('No link clicked');return <div testId="ready" style={{width:'100%',height:'100%',backgroundColor:t.surface,padding:24,display:'flex',flexDirection:'column',gap:28}}>
{Object.entries(sources).map(([id,source])=><markdown key={id} testId={id} source={source} theme={theme} onLinkClick={e=>setClicked(e.value??'')} style={{width:id==='code'?560:400,color:t.text,userSelect:'text'}}/>)}
<text testId="clicked" style={{color:t.text,fontSize:14}}>{clicked}</text>
</div>}
render(<Lab/>,{title:'Link hover',width:640,height:650,focus:false})
