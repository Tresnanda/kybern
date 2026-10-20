/** Regression: subtle changes, missing/opposite states, regional defects and no-op references. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { strict as assert } from 'node:assert'
const dir=mkdtempSync(path.join(tmpdir(),'kybern-delta-test-'))
const run=(args:string[])=>{const p=Bun.spawnSync(args,{stdout:'pipe',stderr:'pipe'}); assert.equal(p.exitCode,0,p.stderr.toString()); return p.stdout.toString()}
try {
 const generator=path.join(dir,'generate.swift')
 writeFileSync(generator,`import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
for (name,delta) in [("base",0),("subtle",6),("reverse",-6),("half",3),("large",60),("large-plus-small",61)] {
 let c=CGContext(data:nil,width:256,height:128,bitsPerComponent:8,bytesPerRow:1024,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
 let p=c.data!.assumingMemoryBound(to:UInt8.self)
 for y in 0..<128 { for x in 0..<256 { let i=(y*256+x)*4; for k in 0..<3 { p[i+k]=UInt8(100+(x<128 ? (delta==61 ? 60 : delta) : (delta==61 ? 1 : 0))) }; p[i+3]=255 } }
 let d=CGImageDestinationCreateWithURL(URL(fileURLWithPath:CommandLine.arguments[1]+"/"+name+".png") as CFURL,UTType.png.identifier as CFString,1,nil)!
 CGImageDestinationAddImage(d,c.makeImage()!,nil); CGImageDestinationFinalize(d)
}`)
 run(['swift',generator,dir])
 const score=(ref:string,native:string)=>JSON.parse(run(['swift',path.resolve(import.meta.dir,'../visual/state-delta.swift'),...['base',ref,'base',native].map(s=>path.join(dir,s+'.png')),path.join(dir,'heat.png')]))
 assert.equal(score('subtle','subtle').score,100)
 assert.equal(score('subtle','base').score,0)
 assert.equal(score('subtle','base').verdict,'FAIL')
 assert.equal(score('subtle','reverse').score,0)
 assert.ok(Math.abs(score('subtle','half').score-66.6667)<0.001)
 assert.equal(score('base','base').verdict,'INCONCLUSIVE')
 const regional=score('large-plus-small','large')
 assert.ok(regional.score>99)
 assert.equal(regional.worstRegionScore,0)
 assert.equal(regional.verdict,'FAIL')
 const legacy=run(['swift',path.resolve(import.meta.dir,'../visual/compose.swift'),path.join(dir,'base.png'),path.join(dir,'subtle.png'),path.join(dir,'pair.png'),path.join(dir,'diff.png')])
 assert.match(legacy,/0.00%/)
 const low=run(['swift',path.resolve(import.meta.dir,'../visual/compose.swift'),path.join(dir,'base.png'),path.join(dir,'subtle.png'),path.join(dir,'pair.png'),path.join(dir,'diff.png'),'5'])
 assert.match(low,/50.00%/)
 console.log('PASS: subtle/missing/reversed/half-strength/no-op states and legacy/low thresholds')
} finally { rmSync(dir,{recursive:true,force:true}) }
