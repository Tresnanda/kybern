import '../src/native/local-build.ts'
import { waitForPainted } from '../src/requests/harness.ts'
import { GAPS, beforeAddon, capture, launch, outputDir, settled, step } from './check-harness.ts'
import path from 'node:path'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pixels } from './png.ts'
import { BLOCKS_A, BLOCKS_B, BLOCKS_C } from '../visual/fixture.convo9.ts'
const out=outputDir('markdown')
mkdirSync(path.join(import.meta.dir,'build'),{recursive:true})
for(const mode of (process.env.MD_API_ONLY==='1'?[]:['dark','light'])) {
 for(const document of ['0','1']) {
  const f=await launch(path.join(import.meta.dir,'markdown-document-lab.tsx'),{KYBERN_APPEARANCE:mode,MD_DOCUMENT:document,...(document==='0'?{NAPI_RS_NATIVE_LIBRARY_PATH:beforeAddon()}:{})})
  try {
   await f.app.getByTestId('ready').waitFor();await waitForPainted(f.app,'Markdown parity')
   await capture(f,`${out}/document-${mode}-${document}.png`)
   await f.app.mouse.wheel({x:300,y:300},0,-450);await f.app.clock.fastForward(64)
   await capture(f,`${out}/document-${mode}-${document}-scrolled.png`)
  } finally {await f.close()}
 }
 for(const suffix of ['','-scrolled']) {
  const a=pixels(`${out}/document-${mode}-0${suffix}.png`),b=pixels(`${out}/document-${mode}-1${suffix}.png`)
  assert.equal(a.w,b.w);assert.equal(a.h,b.h)
  let changed=0,max=0
  for(let y=12;y<a.h-12;y++)for(let x=8;x<a.w-8;x++) {
   const p=a.at(x,y),q=b.at(x,y)
   const diff=Math.max(...p.map((value,i)=>Math.abs(value-q[i]!)))
   if(diff>0)changed++;max=Math.max(max,diff)
  }
  assert.equal(changed,0,`${mode}${suffix}: ${changed} changed pixels, max ${max}`)
 }
 console.log(`ok ${mode}: canonical document pixels equal original Markdown at top and after scrolling`)
}
const f=await launch(path.join(import.meta.dir,'markdown-document-api-lab.tsx'),{GPUIX_BACKGROUND:'1'})
try {
 await f.app.getByTestId('api-ready').waitFor({timeoutMs:60_000})
 let result:any
 for(let i=0;i<200;i++){const text=await f.app.getByTestId('api-result').textContent();if(text){result=JSON.parse(text);break}await Bun.sleep(50)}
 assert.ok(result);assert.ok(!result.error,result.error)
 for(const key of ['prefixIds','textExact','stale','fullInvalidation','sameBlocks','noParse','cancelled','released','sizeLimit','documentLimit','aggregateLimit','queueLimit'])assert.equal(result[key],true,key)
 assert.ok(result.stable>190);assert.ok(result.bytes<200)
 assert.equal(result.after.documents,result.before.documents);assert.equal(result.after.sourceBytes,result.before.sourceBytes)
 await waitForPainted(f.app,'Paragraph')
 await f.app.getByTestId('api-ready').press('l')
 const layout=JSON.parse(await f.app.getByTestId('api-result').textContent())
 assert.ok(layout.width>0);assert.ok(layout.blocks.length>190);assert.ok(layout.blocks.every((b:any)=>b.height>0))
 await f.app.getByTestId('api-ready').press('n')
 for(let i=0;i<100;i++){if((await f.app.getByTestId('api-result').textContent()).includes('noopRevision'))break;await Bun.sleep(10)}
 let noopLayout:any=null
 for(let i=0;i<100;i++){await f.app.getByTestId('api-ready').press('l');noopLayout=JSON.parse(await f.app.getByTestId('api-result').textContent());if(noopLayout?.blocks)break;await Bun.sleep(10)}
 assert.deepEqual(noopLayout,layout,'No-op revisions republish the existing exact block geometry')
 console.log('ok documents: exact source/global references, stable IDs, tail parse, no-op, revision races, cancellation, release, limits and measured block heights')
}catch(error){console.error(f.diagnostics());throw error}finally{await f.close()}

for(const mode of (process.env.MD_API_ONLY==='1'?[]:['dark','light'])) {
 const f=await launch(path.join(import.meta.dir,'markdown-document-lab.tsx'),{KYBERN_APPEARANCE:mode,MD_CHECK:'1',MD_DOCUMENT:'1'}),a=f.app
 try {
 await a.getByTestId('check-ready').waitFor();await waitForPainted(a,'😀é')
 const inline=await a.getByTestId('inline').bounds()
 await a.mouse.down({x:inline.x,y:inline.y+10});await a.mouse.move({x:inline.x+290,y:inline.y+10},{pressedButton:0});await a.mouse.up({x:inline.x+290,y:inline.y+10})
 await a.getByTestId('check-ready').press('g')
 const selection=JSON.parse(await a.getByTestId('result').textContent());assert.equal(selection.text,'one 😀é two','Inline padding must not add text/newlines')
 await a.getByTestId('check-ready').press('h');const washes=JSON.parse(await a.getByTestId('result').textContent())
 assert.equal(washes.map((w:any)=>w.text.slice(w.start,w.end)).join(''),'one inline code two','Search match must span the paragraph fragments')
 assert.equal(washes.find((w:any)=>w.text==='inline code')?.rects.length,1,'A fitting code span must not wrap after pixel snapping');
 assert.ok((await a.getByTestId('hardbreak').bounds()).height>40,'Hard breaks retain their second line');
 await a.getByTestId('check-ready').press('r');await a.clock.fastForward(32);await a.getByTestId('check-ready').press('g');assert.equal(JSON.parse(await a.getByTestId('result').textContent()).text,'one 😀é two','Reflow retains selection identity');await a.getByTestId('check-ready').press('r')
 const before=await a.getByTestId('wrap-code').bounds()
 await a.getByTestId('wrap').click();await a.clock.fastForward(32)
 const after=await settled(()=>a.getByTestId('wrap-code').bounds(),b=>b.height>before.height+30);assert.ok(after.height>before.height+30,`Wrap must grow code: ${before.height} -> ${after.height}`)
 const file=path.join(out,`capability-${mode}.png`);await capture(f,file);const grid=pixels(file)
 await a.getByTestId('grid').click();await a.clock.fastForward(32)
 const file2=path.join(out,`capability-${mode}-no-grid.png`);await capture(f,file2);const plain=pixels(file2)
 let redBefore=0,redAfter=0
 for(let y=0;y<grid.h;y++)for(let x=0;x<grid.w;x++){const c=grid.at(x,y),d=plain.at(x,y);if(c[0]!>240&&c[1]!<20&&c[2]!<20)redBefore++;if(d[0]!>240&&d[1]!<20&&d[2]!<20)redAfter++}
 assert.ok(redBefore>redAfter+500,'Grid adds actual outer/vertical borders')
 console.log(`ok ${mode}: exact Unicode selection across padded boxes, paragraph search, code wrap ${before.height} -> ${after.height}, grid paint`)
 }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
}

// Cross the interior chunk thresholds with one semantic block per source.
if(process.env.MD_API_ONLY!=='1') for(const [name,source] of Object.entries({
 convo9a:BLOCKS_A, convo9b:BLOCKS_B, convo9c:BLOCKS_C,
 wrappedcode:'```typescript\n'+Array.from({length:80},(_,i)=>`const item${i} = "Unicode 😀é and a long wrapped row ${"content ".repeat(20)}";\n`).join('')+'```\n\nAfter the wrapped fence.',

 wrappedquote:Array.from({length:80},(_,i)=>`> Quote **${i}** with \`inline code\` and ${'long wrapping continuation text '.repeat(20)}\n>\n> > Nested quote **${i}** ${'with more wrapping text '.repeat(15)}\n>\n> After the nested quote.\n>\n`).join(''),
 bidi:('עברית **מודגש** العربية [קישור][ref] 123 text. ').repeat(1500)+'\n\n[ref]: https://example.com/rtl',
 cjk:('漢字かなカナ😀é 組版と改行。').repeat(1800),
 paragraph:'A **bold** [reference][ref] 😀é phrase. '.repeat(1800)+'\n\n[ref]: https://example.com/global',
 inline:('text `inline 😀é` **bold** and [link][ref] ').repeat(1600)+'\n\n[ref]: https://example.com/global',
 quote:Array.from({length:300},(_,i)=>`> Quote **${i}** with \`code\`.\n>\n> > Nested quote ${i}.\n>\n`).join(''),
 semantics:'# Semantics\n\n[reference][global] ![image alt](https://example.com/image.png) [^note]\n\n- [x] Done\n  continuation\n  - nested **text**\n\n> outer\n> > inner [reference][global]\n\n```mermaid\ngraph TD; A-->B;\n```\n\n[global]: https://example.com/global "title"\n\n[^note]: Footnote content.\n',
 table:'| Name | Value |\n|---|---:|\n'+Array.from({length:500},(_,i)=>`| Row **${i}** | \`value${i}\` |\n`).join(''),
 code:'```typescript\n/* multiline\ncomment */\n'+Array.from({length:700},(_,i)=>`const item${i} = "😀é";\n`).join('')+'```',
 list:Array.from({length:400},(_,i)=>`- Item **${i}** with \`code\`\n  continuation\n  - Nested item ${i}\n`).join(''),
}).filter(([name])=>!process.env.MD_INTERIOR_CASES||process.env.MD_INTERIOR_CASES.split(',').includes(name))) {
 const file=path.join(import.meta.dir,'build',`markdown-${name}.md`);writeFileSync(file,source)
 for(const mode of ['dark','light']) {
  for(const document of ['0','1']) {
   const f=await launch(path.join(import.meta.dir,'markdown-document-lab.tsx'),{KYBERN_APPEARANCE:mode,MD_DOCUMENT:document,MD_DOC_SOURCE:file,MD_WRAP:name==='wrappedcode'?'1':'0',...(document==='0'?{NAPI_RS_NATIVE_LIBRARY_PATH:beforeAddon()}:{})})
   try {
    await f.app.getByTestId('ready').waitFor();await waitForPainted(f.app,name==='wrappedcode'?'item0':name==='convo9a'?'Here is a tour':name==='convo9b'?'Paragraph before':name==='convo9c'?'A table follows':name==='table'?'Name':name==='code'?'item0':name==='list'?'Item':name==='inline'?'inline':(name==='quote'||name==='wrappedquote')?'Quote':name==='semantics'?'Semantics':name==='bidi'?'עברית':name==='cjk'?'漢字':'phrase',60_000)
    for(const position of ['top','middle']) {
     if(position==='middle'){await f.app.mouse.wheel({x:300,y:300},0,-3500);await f.app.clock.fastForward(64)}
     await capture(f,`${out}/interior-${name}-${mode}-${document}-${position}.png`)
    }
   } finally {await f.close()}
  }
  for(const position of ['top','middle']) {
   const a=pixels(`${out}/interior-${name}-${mode}-0-${position}.png`),b=pixels(`${out}/interior-${name}-${mode}-1-${position}.png`)
   assert.equal(a.w,b.w);assert.equal(a.h,b.h)
   let changed=0
   for(let y=12;y<a.h-12;y++)for(let x=8;x<a.w-8;x++)if(a.at(x,y).some((v,i)=>v!==b.at(x,y)[i]))changed++
   assert.equal(changed,0,`${name}/${mode}/${position}: ${changed} changed pixels`)
  }
  console.log(`ok ${name}/${mode}: huge semantic block pixels equal before and after wheel jump`)
 }
}

if(process.env.MD_API_ONLY!=='1') for(const document of ['1']) {
 const f=await launch(path.join(import.meta.dir,'markdown-document-selection-lab.tsx'),{MD_DOCUMENT:document,...(document==='0'?{NAPI_RS_NATIVE_LIBRARY_PATH:beforeAddon()}:{})})
 try {
  const a=f.app
  await a.getByTestId('selection-ready').waitFor();await waitForPainted(a,'Start',60_000)
  await step(`copy/${document} across a viewport jump`,async()=>{
    const box=await a.getByTestId('selection-scroll').bounds()
    const markdown=await a.getByTestId('selection-markdown').bounds()
    await a.mouse.down({x:markdown.x,y:markdown.y+8})
    await a.mouse.move({x:markdown.x+100,y:markdown.y+8},{pressedButton:0})
    await a.mouse.wheel({x:300,y:300},0,-1000000);await a.clock.fastForward(64);await waitForPainted(a,'sentinel',60_000)
    const end={x:box.x+600,y:box.y+box.height-32}
    await a.mouse.move(end,{pressedButton:0});await a.mouse.up(end)
    await a.getByTestId('selection-ready').press('g')
    const selected=await a.getByTestId('selection-result').textContent()
    assert.equal(selected,['Start 😀é.',...Array.from({length:100},(_,i)=>`Middle ${i}.`),'End sentinel.'].join('\n'),'Copy must include every unpainted intermediate paragraph in document order')
    console.log(`ok copy/${document}: exact Unicode source order across a viewport jump and 100 unpainted paragraphs`)
  },{gap:GAPS.wheel})
 }catch(error){console.error(f.diagnostics());throw error}finally{await f.close()}
}
