/** In-process view of compositor loops (native/patches/compositor_loops_*): the Core Animation sublayers of every
 * window's Metal layer, their frames (points, bottom-left origin), fills, radii, the ink of masked (sprite) layers
 * rendered in place (rows top-first), and their presentation opacity sampled every ~4 ms for `durationMs`. Reads
 * only this process's own layers, so it needs no screen-recording permission. */
export async function caProbe(durationMs: number) {

  const objc=await import('../../src/native/objc.ts'),{dlopen,FFIType,read}=await import('bun:ffi')
  const o=objc.getObjc(),sel=(n:string)=>objc.sel(o,n),lib='/usr/lib/libobjc.A.dylib'
  const f32=dlopen(lib,{objc_msgSend:{args:[FFIType.ptr,FFIType.ptr],returns:FFIType.f32}}).symbols.objc_msgSend
  const f64=dlopen(lib,{objc_msgSend:{args:[FFIType.ptr,FFIType.ptr],returns:FFIType.f64}}).symbols.objc_msgSend
  const cg=dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics',{CGColorGetComponents:{args:[FFIType.ptr],returns:FFIType.ptr},CGColorGetNumberOfComponents:{args:[FFIType.ptr],returns:FFIType.u64}}).symbols
  const nsKey=(k:string)=>o.msgPtrArg(objc.cls(o,'NSString') as never,sel('stringWithUTF8String:'),objc.cstr(k) as never)
  const layers:unknown[]=[],metal:string[]=[]
  const rect=(l:unknown)=>String(o.msgCStr(o.msg(o.msgPtrArg(l as never,sel('valueForKey:'),nsKey('bounds') as never) as never,sel('description')) as never,sel('UTF8String')))
  const walk=(layer:unknown)=>{objc.each(o,o.msg(layer as never,sel('sublayers')) as never,sub=>{if(objc.className(o,sub as never)==='CAMetalLayer'){metal.push(rect(sub));objc.each(o,o.msg(sub as never,sel('sublayers')) as never,l=>{layers.push(l)})}else walk(sub)})}
  objc.each(o,o.msg(objc.nsApp() as never,sel('windows')) as never,w=>{const view=o.msg(w as never,sel('contentView'));const layer=view&&o.msg(view as never,sel('layer'));if(layer)walk(layer)})
  const describe=(l:unknown)=>{
   const frame=String(o.msgCStr(o.msg(o.msgPtrArg(l as never,sel('valueForKey:'),nsKey('frame') as never) as never,sel('description')) as never,sel('UTF8String')))
   const color=o.msg(l as never,sel('backgroundColor')),n=Number(cg.CGColorGetNumberOfComponents(color as never)),c=cg.CGColorGetComponents(color as never)
   return {frame,color:Array.from({length:n},(_,i)=>read.f64(c as never,i*8)),radius:f64(l as never,sel('cornerRadius')),modelOpacity:f32(l as never,sel('opacity'))}
  }
  // Masked (sprite) layers: render the layer itself and report where its ink sits (rows are top-first).
  const bitmap=dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics',{CGBitmapContextCreate:{args:[FFIType.ptr,FFIType.u64,FFIType.u64,FFIType.u64,FFIType.u64,FFIType.ptr,FFIType.u32],returns:FFIType.ptr},CGColorSpaceCreateDeviceRGB:{args:[],returns:FFIType.ptr},CGContextScaleCTM:{args:[FFIType.ptr,FFIType.f64,FFIType.f64],returns:FFIType.void},CGContextRelease:{args:[FFIType.ptr],returns:FFIType.void}}).symbols
  const ink=(l:unknown,frame:string)=>{
   if(!o.msg(l as never,sel('mask')))return null
   const [,,w,h]=(frame.match(/-?[\d.]+/g)??[]).map(Number),W=Math.round(w!*2),H=Math.round(h!*2),buf=new Uint8Array(W*H*4)
   const ctx=bitmap.CGBitmapContextCreate(buf as never,BigInt(W) as never,BigInt(H) as never,8n as never,BigInt(W*4) as never,bitmap.CGColorSpaceCreateDeviceRGB() as never,1)
   bitmap.CGContextScaleCTM(ctx as never,2,2);o.msgSetPtr(l as never,sel('renderInContext:'),ctx as never);bitmap.CGContextRelease(ctx as never)
   let top=0,bottom=0,left=0,right=0
   for(let y=0;y<H;y++)for(let x=0;x<W;x++){const a=buf[(y*W+x)*4+3]!;if(y<H/2)top+=a;else bottom+=a;if(x<W/2)left+=a;else right+=a}
   return {top,bottom,left,right,rows:Array.from({length:H},(_,y)=>Array.from({length:W},(_,x)=>buf[(y*W+x)*4+3]!>96?'#':buf[(y*W+x)*4+3]!>16?'+':'.').join(''))}
  }
  const info=layers.map(l=>{const d=describe(l);return {...d,ink:ink(l,d.frame)}}),samples:{t:number;opacity:number[];angle:number[]}[]=[],end=performance.now()+durationMs
  while(performance.now()<end){samples.push({t:performance.now(),opacity:layers.map(l=>{const p=o.msg(l as never,sel('presentationLayer'));return p?f32(p as never,sel('opacity')):-1}),angle:layers.map(l=>{const p=o.msg(l as never,sel('presentationLayer'));return p?f64(o.msgPtrArg(p as never,sel('valueForKeyPath:'),nsKey('transform.rotation.z') as never) as never,sel('doubleValue')):0})});await Bun.sleep(4)}
  return {metal,layers:info,samples}
 }
