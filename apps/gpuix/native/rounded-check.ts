import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {inflateSync} from 'node:zlib'
import path from 'node:path'
import {GAPS,capture,launch,outputDir,step,tolerance} from './check-harness.ts'
import {MONO_ADVANCE} from '../src/theme.ts'
// Small PNG reader for native screenshots, avoiding a new test dependency.
function pixels(file:string) {
 const png=readFileSync(file),chunks:Buffer[]=[];let w=0,h=0,bpp=0
 for(let at=8;at<png.length;){const n=png.readUInt32BE(at),kind=png.toString('ascii',at+4,at+8),data=png.subarray(at+8,at+8+n);if(kind==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);assert.equal(data[8],8);assert.equal(data[12],0);bpp=data[9]===6?4:data[9]===2?3:0;assert.ok(bpp)}if(kind==='IDAT')chunks.push(data);at+=12+n}
 const raw=inflateSync(Buffer.concat(chunks)),stride=w*bpp,out=Buffer.alloc(h*stride)
 for(let y=0;y<h;y++){const filter=raw[y*(stride+1)]!;for(let x=0;x<stride;x++){const a=x>=bpp?out[y*stride+x-bpp]!:0,b=y?out[(y-1)*stride+x]!:0,c=y&&x>=bpp?out[(y-1)*stride+x-bpp]!:0,p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);const delta=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):pa<=pb&&pa<=pc?a:pb<=pc?b:c;out[y*stride+x]=(raw[y*(stride+1)+1+x]!+delta)&255}}
 return {w,h,at:(x:number,y:number)=>[...out.subarray((Math.floor(y)*w+Math.floor(x))*bpp,(Math.floor(y)*w+Math.floor(x))*bpp+3)]}
}
const out=outputDir('rounded')
for(const mode of ['dark','light']){
 const f=await launch(path.join(import.meta.dir,'rounded-lab.tsx'),{KYBERN_APPEARANCE:mode}),a=f.app
 try{
 await a.getByTestId('ready').waitFor();await Bun.sleep(150)
 const click=async(id:string)=>{await a.getByTestId(id).click();await Bun.sleep(100);return a.getByTestId('result').textContent()}
 const shot=async(label:string)=>{const file=path.join(out,`${mode}-${label}.png`);await capture(f,file);return pixels(file)}
 const boxes=Object.fromEntries(await Promise.all(['radius','touching','gaps','edges','wrap'].map(async id=>[id,await a.getByTestId(id).bounds()])))
 writeFileSync(path.join(out,`${mode}-bounds.json`),JSON.stringify(boxes,null,2))
 const round=await shot('round'),scale=round.w/840
 const crop=(im:ReturnType<typeof pixels>,id:string)=>{const b=boxes[id]!;const values:number[]=[];for(let y=Math.ceil(b.y*scale);y<Math.floor((b.y+b.height)*scale);y++)for(let x=Math.ceil(b.x*scale);x<Math.floor((b.x+b.width)*scale);x++)values.push(...im.at(x,y));return Buffer.from(values)}
 await click('rect');const rect=await shot('rect');assert.notDeepEqual(crop(round,'radius'),crop(rect,'radius'),'Radius must change actual painted corners')
 await click('round');await click('zero');const zero=await shot('zero');await click('huge');const huge=await shot('huge')
 assert.deepEqual(crop(zero,'touching'),crop(huge,'touching'),'No outset into adjacent glyphs or same-color atoms')
 assert.deepEqual(crop(zero,'edges'),crop(huge,'edges'),'No outset beyond input edges')
 assert.notDeepEqual(crop(zero,'gaps'),crop(huge,'gaps'),'Outset uses available whitespace')
 // At the top of wrapped middle fragments both ends are square; the first/last retain exterior curves.
 const b=boxes.wrap!,fill=mode==='dark'?[40,81,124]:[173,212,252]
 const filled=(im:ReturnType<typeof pixels>,x:number,y:number)=>im.at(x*scale,y*scale).every((c,i)=>Math.abs(c-fill[i]!)<tolerance)
 // Off macOS the fallback face is wider: `edges` wraps too and its second line lands where these samples look (WP8).
 await step(`${mode} wrapped fragment corners`,()=>{
  assert.ok(!filled(round,b.x+0.5,b.y+0.5),'First external corner is rounded')
  assert.ok(filled(round,b.x+0.5,b.y+24.5),'Continuation left corner is square')
 },{gap:GAPS.font})
 // Same-color adjacent atoms retain their own external corners instead of coalescing.
 const touch=boxes.touching!
 // Four advances of the code face at 20 px (48.2 with Menlo; 48 with JetBrains Mono off macOS, WP8).
 await step(`${mode} second atom radius`,()=>assert.ok(!filled(round,touch.x+Math.round(4*MONO_ADVANCE*20*10)/10,touch.y+0.5),'Second atom retains its left radius'),{gap:GAPS.font})
 await click('normal');await click('select');const selected=await shot('selected');assert.notDeepEqual(crop(round,'radius'),crop(selected,'radius'),'Selection paints over the pill')
 const pillBounds=boxes.radius!;assert.notDeepEqual(round.at((pillBounds.x+60)*scale,(pillBounds.y+2)*scale),selected.at((pillBounds.x+60)*scale,(pillBounds.y+2)*scale),'Selection changes an interior background pixel')
 await click('before');await a.getByTestId('radius').press('right');assert.equal(JSON.parse(await click('selection')).start,11)
 await a.getByTestId('radius').press('left');assert.equal(JSON.parse(await click('selection')).start,2)
 assert.match(await click('invalid'),/finite and nonnegative/);assert.match(await click('padding'),/do not support/)
 console.log(`ok ${mode}: rounded pixels, distinct adjacent atoms, neighbour/edge outset clamps, wrapping, selection overlay and atomic caret`)
 }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
}
