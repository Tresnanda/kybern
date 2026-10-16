import React from 'react'
import {createRoot} from 'react-dom/client'
import {MatrixLoader} from '../../desktop/src/components/kybern/motion.tsx'
import {TaskStatusGlyph} from '../../desktop/src/views/tasks/TaskGlyphs.tsx'
import '../../desktop/src/styles/kit.css'
import '../../desktop/src/styles/motion.css'
import '../../desktop/src/styles/tasks.css'
import {THEMES} from '../src/theme.ts'
const theme=new URLSearchParams(location.search).get('theme')==='light'?'light':'dark',light=theme==='light',t=THEMES[theme]
document.documentElement.className=theme
for(const [k,v] of Object.entries({'--task-run':t.taskRun,'--foreground':t.text}))document.documentElement.style.setProperty(k,v)
document.body.style.cssText=`margin:0;padding:24px;box-sizing:border-box;background:${light?'#fafafa':'#202020'};color:${light?'#202020':'#eeeeee'};font-family:-apple-system;font-size:16px;line-height:24px`
createRoot(document.getElementById('root')!).render(<div style={{display:'flex',flexDirection:'column',gap:16}}><div>Display-rate native paint loops</div><div id="loops" style={{display:'flex',gap:28,width:500,height:78}}>{(['orbit','pulse','scan','twinkle'] as const).map(variant=><div key={variant} style={{display:'flex',flexDirection:'column',gap:10,width:80,height:78,flexShrink:0}}><div style={{color:light?'rgba(30,30,30,.9)':'rgba(240,240,240,.9)'}}><MatrixLoader variant={variant} dot={5} gap={5}/></div><div>{variant}</div></div>)}<TaskStatusGlyph status="running" animated/></div><div>Ready</div><div>H: unmount · C: recolor · S/U: subscribe/unsubscribe</div></div>)
