import React from 'react'
import {createRoot} from 'react-dom/client'
import {ThemeProviderContext} from '/Users/mymac/projects/ade/apps/desktop/src/components/theme-context.ts'
import {Markdown} from '/Users/mymac/projects/ade/apps/desktop/src/components/kybern/Markdown.tsx'
import '/Users/mymac/projects/ade/apps/desktop/src/styles/kit.css'
import {sample} from './markdown-sample.ts'
import {THEMES} from '../src/theme.ts'
const mode=new URLSearchParams(location.search).get('theme')==='light'?'light':'dark'
const t=THEMES[mode]
document.documentElement.className=mode
const vars={'--foreground':t.text,'--muted-foreground':t.textSecondary,'--border':t.border,'--app-chat-code-surface':t.codeSurface,'--font-ui-family':'-apple-system','--font-chat-code-family':'Menlo','--app-font-size-chat-code':'13px'}
for(const [key,value] of Object.entries(vars)) document.documentElement.style.setProperty(key,value)
document.body.style.cssText=`margin:0;background:${t.surface};font-family:-apple-system;padding:24px;box-sizing:border-box`
createRoot(document.getElementById('root')!).render(<ThemeProviderContext value={{theme:mode,translucent:false,setTheme:()=>{},setTranslucent:()=>{}}}><Markdown text={sample} style={{fontSize:14,lineHeight:'22.75px'}} /></ThemeProviderContext>)
