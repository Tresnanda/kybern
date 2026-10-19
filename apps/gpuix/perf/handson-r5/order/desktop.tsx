// The actual desktop image/dialog component in a long scroller (no Tauri window).
import React from 'react'
import {createRoot} from 'react-dom/client'
import {ResponseImage} from '../../../../desktop/src/components/kybern/ResponseImage.tsx'
import {ThemeProviderContext} from '../../../../desktop/src/components/theme-context.ts'
import './desktop.css'
import {buildThemeCssVariables,DEFAULT_THEME_STATE} from '../../../../desktop/src/lib/kit/theme/theme.logic.ts'
import {THEMES} from '../../../src/theme.ts'
const mode=new URLSearchParams(location.search).get('theme')==='light'?'light':'dark',t=THEMES[mode]
const source=(window as unknown as {__orderImage:string}).__orderImage
document.documentElement.className=mode
const variables=buildThemeCssVariables({theme:DEFAULT_THEME_STATE.chromeThemes[mode],codeThemeId:DEFAULT_THEME_STATE.codeThemeIds[mode]},mode,{electron:true,isMac:true,systemUiFont:true}).variables
for(const [name,value] of Object.entries(variables))document.documentElement.style.setProperty(name,value)
for(const [name,value] of Object.entries({'--foreground':t.text,'--muted-foreground':t.textSecondary,'--border':t.border,'--popover':t.popover,'--font-ui-family':'-apple-system'}))document.documentElement.style.setProperty(name,value)
document.body.style.cssText=`margin:0;background:${t.surface};color:${t.text};font-family:-apple-system`
createRoot(document.getElementById('root')!).render(<ThemeProviderContext value={{theme:mode,translucent:false,setTheme:()=>{},setTranslucent:()=>{}}}>
 <main id="scroll" style={{height:820,overflow:'auto',padding:'16px 56px'}}>
  {Array.from({length:1000},(_,index)=><section id={`row-${index}`} key={index} style={{height:index%100===0?280:120,maxWidth:736,margin:'0 auto'}}>
   <p style={{padding:'12px 0'}}>Prompt {index}: preserve the reading position.</p>
   {index%100===0&&<ResponseImage source={source} label="Agent image" />}
  </section>)}
 </main>
</ThemeProviderContext>)
