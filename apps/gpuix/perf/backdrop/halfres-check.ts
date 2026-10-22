// N2 pixel equivalence over dense text: the half-resolution wide-blur path
// (default), the full-resolution path (KYBERN_BACKDROP_HALFRES=0, same addon) and
// an exact CPU Gaussian of the unfiltered page (no backdrops, same addon).
// Gate: device sigma > 8 (blur 6, 16, 18 at 2×) within mean 1.5/255 and max 8/255
// per channel of the exact blur; blur 4 (device sigma 8) never halves and must
// equal the full-resolution path. The full-resolution path's 49 taps sit 4 device
// px apart at blur 16 and alias on text, so it is reported, not used as the
// reference (see native/README.md, N2).
import '../../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdirSync,writeFileSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
import {pixels} from '../../native/png.ts'
const out=process.env.KYBERN_VERIFY_OUTPUT??path.resolve(import.meta.dir,'../../native/build/halfres')
// The fixture never talks to a daemon; the harness still requires a scratch data dir outside ~/.kybern.
const scratch=process.env.KYBERN_HALFRES_SCRATCH??path.join(process.env.TMPDIR??'/tmp','kybern-halfres-check')
mkdirSync(out,{recursive:true});mkdirSync(scratch,{recursive:true})
const results:unknown[]=[],failures:string[]=[],BLURS=[4,6,16,18],SATURATION=1.25
type Image=ReturnType<typeof pixels>
type Box={x:number,y:number,width:number,height:number}
/** Exact separable Gaussian (±4 sigma, clamp to edge) of `source`, then the shader's saturation, over `box` (device px). */
function exact(source:Image,sigma:number,[x0,y0,x1,y1]:number[]){
 const R=Math.ceil(sigma*4),w:number[]=[];let total=0;for(let i=-R;i<=R;i++){const v=Math.exp(-.5*i*i/(sigma*sigma));w.push(v);total+=v}
 const {w:W,h:H,channels:C,data}=source,cw=x1!-x0!,ry0=Math.max(0,y0!-R),ry1=Math.min(H,y1!+R),rows=new Float64Array((ry1-ry0)*cw*3),result=new Float64Array((y1!-y0!)*cw*3)
 for(let y=ry0;y<ry1;y++)for(let x=x0!;x<x1!;x++)for(let c=0;c<3;c++){let a=0;for(let i=-R;i<=R;i++)a+=data[(y*W+Math.min(W-1,Math.max(0,x+i)))*C+c]!*w[i+R]!;rows[((y-ry0)*cw+x-x0!)*3+c]=a/total}
 for(let y=y0!;y<y1!;y++)for(let x=x0!;x<x1!;x++){
  const t=[0,0,0].map((_,c)=>{let a=0;for(let i=-R;i<=R;i++)a+=rows[((Math.min(ry1-1,Math.max(ry0,y+i))-ry0)*cw+x-x0!)*3+c]!*w[i+R]!;return a/total})
  const l=.2126*t[0]!+.7152*t[1]!+.0722*t[2]!
  for(let c=0;c<3;c++)result[((y-y0!)*cw+x-x0!)*3+c]=Math.round(Math.min(255,Math.max(0,l+(t[c]!-l)*SATURATION)))
 }
 return (x:number,y:number,c:number)=>result[((y-y0!)*cw+x-x0!)*3+c]!
}
function compare(read:(x:number,y:number,c:number)=>number,image:Image,[x0,y0,x1,y1]:number[]){
 let max=0,sum=0,n=0
 for(let y=y0!;y<y1!;y++)for(let x=x0!;x<x1!;x++){const p=image.at(x,y);for(let c=0;c<3;c++){const d=Math.abs(p[c]!-read(x,y,c));max=Math.max(max,d);sum+=d;n++}}
 return {mean:+(sum/n).toFixed(3),max:+max.toFixed(1)}
}
for(const theme of ['dark','light']){
 const files:Record<string,string>={},cells:Record<number,Box>={}
 for(const mode of ['source','full','half']){
  const f=await launchFixture(path.resolve(import.meta.dir,'halfres-lab.tsx'),{KYBERN_DATA_DIR:scratch,KYBERN_CLIENT_CONFIG_DIR:path.join(scratch,'client'),KYBERN_URL:'',KYBERN_TOKEN:'',GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_BACKDROP_HALFRES:mode==='half'?'1':'0',KYBERN_HALFRES_SOURCE:mode==='source'?'1':'0',KYBERN_GPU_TRACE:'1'})
  try{
   await f.app.getByTestId('app-ready').waitFor();await Bun.sleep(300)
   if(mode!=='source')for(const blur of BLURS)cells[blur]=await f.app.getByTestId(`cell-${blur}`).bounds()
   const file=`${out}/${theme}-${mode}.png`;await f.app.screenshot({path:file});files[mode]=file
   // The trace names the path each backdrop took; the control must never halve.
   const trace=f.diagnostics()
   if(mode!=='source')assert.ok(mode==='half'?/halfres=true/.test(trace):!/halfres=true/.test(trace),`${mode}: unexpected backdrop path in trace`)
  }finally{await f.close()}
 }
 const source=pixels(files.source!),full=pixels(files.full!),half=pixels(files.half!),scale=full.w/630
 assert.equal(full.w,half.w);assert.equal(source.w,half.w)
 for(const blur of BLURS){
  const c=cells[blur]!,sigma=blur*scale
  // Interior only: the rounded edge blends against the unfiltered page identically in both paths.
  const box=[Math.ceil((c.x+16)*scale),Math.ceil((c.y+16)*scale),Math.floor((c.x+c.width-16)*scale),Math.floor((c.y+c.height-16)*scale)]
  const truth=exact(source,sigma,box)
  const row={theme,blur,deviceSigma:sigma,halfVsExact:compare(truth,half,box),fullVsExact:compare(truth,full,box),halfVsFull:compare((x,y,k)=>full.at(x,y)[k]!,half,box)}
  results.push(row);console.log(JSON.stringify(row))
  let low=255,high=0;for(let y=box[1]!;y<box[3]!;y++)for(let x=box[0]!;x<box[2]!;x++)for(const v of full.at(x,y)){low=Math.min(low,v);high=Math.max(high,v)}
  if(high-low<=20)failures.push(`${theme} blur ${blur}: blurred source lost its contrast; the lab is not exercising the filter`)
  if(sigma<=8){if(row.halfVsFull.max!==0)failures.push(`${theme} blur ${blur}: device sigma <= 8 must keep the full-resolution path (max ${row.halfVsFull.max})`)}
  else{
   if(row.halfVsExact.mean>1.5)failures.push(`${theme} blur ${blur}: mean ${row.halfVsExact.mean} > 1.5/255 of the exact blur`)
   if(row.halfVsExact.max>8)failures.push(`${theme} blur ${blur}: max ${row.halfVsExact.max} > 8/255 of the exact blur`)
  }
 }
}
writeFileSync(out+'/results.json',JSON.stringify(results,null,2))
assert.deepEqual(failures,[])
console.log(`ok halfres: ${out}`)
