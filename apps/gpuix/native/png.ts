import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {inflateSync} from 'node:zlib'
export function pixels(file:string) {
 const png=readFileSync(file),chunks:Buffer[]=[];let w=0,h=0,bpp=0
 for(let at=8;at<png.length;){const n=png.readUInt32BE(at),kind=png.toString('ascii',at+4,at+8),data=png.subarray(at+8,at+8+n);if(kind==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);assert.equal(data[8],8);assert.equal(data[12],0);bpp=data[9]===6?4:data[9]===2?3:0;assert.ok(bpp)}if(kind==='IDAT')chunks.push(data);at+=12+n}
 const raw=inflateSync(Buffer.concat(chunks)),stride=w*bpp,out=Buffer.alloc(h*stride)
 for(let y=0;y<h;y++){const filter=raw[y*(stride+1)]!;for(let x=0;x<stride;x++){const a=x>=bpp?out[y*stride+x-bpp]!:0,b=y?out[(y-1)*stride+x]!:0,c=y&&x>=bpp?out[(y-1)*stride+x-bpp]!:0,p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);const delta=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):pa<=pb&&pa<=pc?a:pb<=pc?b:c;out[y*stride+x]=(raw[y*(stride+1)+1+x]!+delta)&255}}
 return {w,h,at:(x:number,y:number)=>[...out.subarray((Math.floor(y)*w+Math.floor(x))*bpp,(Math.floor(y)*w+Math.floor(x))*bpp+3)]}
}
