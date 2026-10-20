import React from 'react'
import {createRoot} from 'react-dom/client'
import {ThemeProviderContext} from '/Users/mymac/projects/ade/apps/desktop/src/components/theme-context.ts'
import {FileDiffCard} from '/Users/mymac/projects/ade/apps/desktop/src/components/kybern/DiffView.tsx'
import {parseUnifiedDiff} from '/Users/mymac/projects/ade/apps/desktop/src/lib/diff.ts'
import './diff-webkit.css'
import {sample} from './diff-sample.ts'
import {THEMES} from '../src/theme.ts'
const mode=new URLSearchParams(location.search).get('theme')==='light'?'light':'dark'
const t=THEMES[mode]
document.documentElement.className=mode
const vars={'--background':t.v('--background'),'--color-border':t.border,'--foreground':t.text,'--muted-foreground':t.textSecondary,'--border':t.border,'--app-chat-code-surface':t.codeSurface,'--font-ui-family':'-apple-system','--font-chat-code-family':'Menlo','--app-font-size-chat-code':'13px'}
for(const key of Object.keys(t.raw)) document.documentElement.style.setProperty(key,t.v(key))
for(const [key,value] of Object.entries(vars)) document.documentElement.style.setProperty(key,value)
document.body.style.cssText=`margin:0;background:${t.surface};font-family:-apple-system;padding:24px;box-sizing:border-box`
createRoot(document.getElementById('root')!).render(<ThemeProviderContext value={{theme:mode,translucent:false,setTheme:()=>{},setTranslucent:()=>{}}}>{parseUnifiedDiff(sample).map(file=><FileDiffCard key={file.path} file={file}/>)}</ThemeProviderContext>)
