import {mkdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'
const settled=async p=>{
 await p.evaluate(async()=>{let previous='',stable=0;for(let frame=0;frame<240;frame++){await new Promise(requestAnimationFrame);const current=JSON.stringify([...document.querySelectorAll('.chat-content-card.workspace-card,.app-sidebar-panel')].map(e=>{const r=e.getBoundingClientRect();return[r.x,r.y,r.width,r.height]}));stable=current===previous?stable+1:0;previous=current;if(stable>=4)return}throw Error('Workspace geometry did not settle')})
}
const workspace=(sidebar,dock)=>async p=>{
 await p.getByText('Rounded clip review',{exact:true}).first().click();await p.locator('.chat-markdown-codeblock').first().waitFor()
 await p.waitForFunction(()=>{const blocks=[...document.querySelectorAll('.chat-markdown-codeblock')];return blocks.length>=2&&blocks.every(b=>b.querySelector('.shiki'))})
 if(dock){if(!await p.getByRole('button',{name:'Add panel',exact:true}).count())await p.keyboard.press('Meta+j');await p.getByRole('button',{name:'Add panel',exact:true}).waitFor()}
 if(!sidebar){await p.getByRole('button',{name:'Toggle thread sidebar'}).click();await p.waitForFunction(()=>document.querySelector('[data-slot="sidebar"][data-state="collapsed"]'))}
 await p.mouse.move(1275,815);await settled(p)
}
export const screens={
 'clip-sidebar-dock':workspace(true,true),'clip-sidebar':workspace(true,false),
 'clip-dock':workspace(false,true),'clip-closed':workspace(false,false),
 'clip-split':async p=>{await workspace(true,false)(p);await p.keyboard.press('Meta+\\');await p.waitForFunction(()=>document.querySelectorAll('[data-split-thread-pane]').length>=2)},
 'clip-narrow':async p=>{await p.setViewportSize({width:920,height:820});await workspace(true,true)(p)},
 'clip-code-horizontal':async p=>{
  await workspace(false,false)(p);const code=p.locator('.chat-markdown-codeblock').last(),before=await code.boundingBox()
  await p.mouse.move(before.x+before.width/2,before.y+before.height-12);await p.mouse.wheel(240,0)
  await p.waitForFunction(()=>[...document.querySelectorAll('.chat-markdown-codeblock pre')].at(-1).scrollLeft>100)
  if(Math.abs((await code.boundingBox()).x-before.x)>.1)throw Error('Horizontal code wheel moved the whole transcript')
 },
 'clip-code-wrapped':async p=>{
  await workspace(false,false)(p);const code=p.locator('.chat-markdown-codeblock').last(),before=await code.boundingBox(),button=await p.getByRole('button',{name:/[Ww]rap/}).last().boundingBox()
  await p.mouse.click(button.x+button.width/2,button.y+button.height/2)
  await p.waitForFunction(()=>[...document.querySelectorAll('.chat-markdown-codeblock')].at(-1).dataset.wrap==='true')
  if(Math.abs((await code.boundingBox()).x-before.x)>.1)throw Error('Wrap click moved the whole transcript')
 },
 'clip-panel-motion':async p=>{
  await workspace(true,false)(p);await p.getByRole('button',{name:'Toggle thread sidebar'}).click()
  await p.evaluate(()=>{window.__clipMotions=document.getAnimations().filter(a=>a.effect?.target?.closest?.('[data-slot="sidebar-container"]')||a.effect?.target?.classList?.contains('chat-content-card')||a.effect?.getKeyframes?.().some(k=>'width'in k));for(const a of window.__clipMotions)a.pause()})
  await p.mouse.move(1275,815)
  const theme=await p.evaluate(()=>matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'),dir=path.join(process.env.KYBERN_VERIFY_OUTPUT,`panel-${theme}-tauri`);mkdirSync(dir,{recursive:true})
  const geometry=[]
  for(const time of [0,40,80,140,220,320]){await p.evaluate(t=>{for(const a of window.__clipMotions)a.currentTime=t},time);await p.screenshot({path:path.join(dir,`t${time}.png`)});geometry.push({time,card:await p.locator('.chat-content-card.workspace-card').boundingBox()})}
  writeFileSync(path.join(dir,'geometry.json'),JSON.stringify(geometry,null,2))
  if(process.env.KYBERN_REDUCED_MOTION==='0'&&Math.abs(geometry[0].card.x-geometry.at(-1).card.x)<10)throw Error('Tauri strip did not contain sidebar movement')
 },
}
for(const name of Object.keys(screens)){
 const step=screens[name]
 screens[name]=async p=>{
  await step(p);if(!process.env.KYBERN_VERIFY_OUTPUT)return
  await p.waitForFunction(()=>[...document.querySelectorAll('.chat-markdown-codeblock')].every(b=>b.querySelector('.shiki')))
  // Geometry must describe the captured endpoint, not a collapsed data-state
  // whose CSS width transition is still running.
  await settled(p)
  const data=await p.evaluate(()=>{
   const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}}
   const surfaces=[...document.querySelectorAll('.chat-content-card.workspace-card,.app-sidebar-panel')].filter(e=>!e.closest('[data-state="collapsed"]')).map(box).filter(b=>b.width>0&&b.height>0)
   const x=Math.min(...surfaces.map(b=>b.x)),y=Math.min(...surfaces.map(b=>b.y)),right=Math.max(...surfaces.map(b=>b.x+b.width)),bottom=Math.max(...surfaces.map(b=>b.y+b.height))
   return{window:{width:innerWidth,height:innerHeight},workspace:{x,y,width:right-x,height:bottom-y},code:[...document.querySelectorAll('.chat-markdown-codeblock')].map(box),theme:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}
  })
  mkdirSync(process.env.KYBERN_VERIFY_OUTPUT,{recursive:true});writeFileSync(path.join(process.env.KYBERN_VERIFY_OUTPUT,`${name}-${data.theme}-tauri-bounds.json`),JSON.stringify(data,null,2))
 }
}
