import React from 'react'
import {createRoot} from 'react-dom/client'
import {ThemeProviderContext} from '/Users/mymac/projects/ade/apps/desktop/src/components/theme-context.ts'
import {Markdown} from '/Users/mymac/projects/ade/apps/desktop/src/components/kybern/Markdown.tsx'
import '/Users/mymac/projects/ade/apps/desktop/src/styles/kit.css'
import '/Users/mymac/projects/ade/apps/desktop/src/styles/kybern.css'
import {THEMES} from '../src/theme.ts'
const mode=new URLSearchParams(location.search).get('theme')==='light'?'light':'dark',light=mode==='light',t=THEMES[mode]
document.documentElement.className=mode
document.documentElement.setAttribute('data-full-translucency','')
document.documentElement.setAttribute('data-window-material','translucent')
const fill=light?'rgba(255,255,255,0.65)':'rgba(30,32,37,0.65)'
const vars={'--app-chat-code-surface':t.codeSurface,'--app-font-size-chat-code':'13px','--font-chat-code-family':'Menlo','--foreground':t.text,'--muted-foreground':t.textSecondary,'--border':t.border,'--color-token-text-link-foreground':'#368ded','--color-token-text-link-active-foreground':'#368ded','--font-ui-family':'-apple-system','--app-glass-popup-surface':fill}
for(const [key,value] of Object.entries(vars))document.documentElement.style.setProperty(key,value)
document.body.style.cssText=`margin:0;background:${t.surface};font-family:-apple-system;box-sizing:border-box;color:${t.text}`
const style=document.createElement('style');style.textContent='*{box-sizing:border-box}::-webkit-scrollbar{display:none}.chat-markdown a{font-weight:600}';document.head.append(style)
const linkView=new URLSearchParams(location.search).get('view')==='links'
function Links(){return <div style={{padding:24,display:'flex',flexDirection:'column',gap:20}}>{(['none','always','hover'] as const).map(underline=><div key={underline} style={{display:'flex',flexDirection:'column',gap:6}}><div style={{fontSize:14,lineHeight:'22.5px'}}>{`Underline: ${underline}`}</div><div className={`link-${underline}`}><Markdown text="[Link alpha](https://example.com/one) and [Link beta](https://example.com/two)" style={{fontSize:14,lineHeight:'22.75px'}}/></div></div>)}<div className="link-mixed"><Markdown text="Mixed `code` [link](https://example.com/mixed) and prose." style={{fontSize:14,lineHeight:'22.75px'}}/></div><div style={{fontSize:14,lineHeight:'22.5px'}}>No link clicked</div></div>}
if(linkView){const style=document.createElement('style');style.textContent='.chat-markdown a{font-weight:500}.link-none a{ text-decoration:none!important }.link-always a{text-decoration:underline}.link-mixed a{color:#e36344;font-weight:700}';document.head.append(style)}
createRoot(document.getElementById('root')!).render(<ThemeProviderContext value={{theme:mode,translucent:true,setTheme:()=>{},setTranslucent:()=>{}}}>{linkView?<Links/>:<div style={{position:'relative',width:728,height:600,overflow:'hidden'}}>
<div style={{height:'100%',overflowY:'scroll',padding:24,display:'flex',flexDirection:'column',gap:12}}>{Array.from({length:60},(_,i)=><div key={i} style={{height:64,flexShrink:0,background:i%2?(light?'#e5efff':'#203553'):(light?'#ffe5dd':'#532c25'),padding:12}}><div style={{fontSize:16,lineHeight:'20px'}}>Transcript row {i} — sharp text behind the floating surface</div><div style={{color:i%2?'#368ded':'#e36344',fontSize:14,lineHeight:'20px'}}>BLUE / ORANGE · 0123456789 · live content</div></div>)}</div>
<div data-slot="dialog-popup" style={{position:'absolute',left:180,top:130,width:380,height:260,padding:24,borderRadius:16,background:fill,border:`1px solid ${t.border}`,display:'flex',flexDirection:'column',gap:18}}>
<div style={{fontSize:20,fontWeight:600,lineHeight:'24px'}}>Floating surface</div>
<div style={{fontSize:14,lineHeight:'20px'}}>Foreground stays sharp. The transcript is blurred.</div>
<Markdown text="[First link](https://example.com/one) and [second link](https://example.com/two)" style={{fontSize:14,lineHeight:'22.75px'}}/>
<div style={{fontSize:14,lineHeight:'20px'}}>No link clicked</div>
</div>
<div style={{position:'absolute',left:24,top:16,width:120,height:30,background:t.surface,fontSize:14}}>Toggle surface</div>
</div>}</ThemeProviderContext>)
