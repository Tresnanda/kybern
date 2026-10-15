// state-delta.swift reference-base reference-state native-base native-state heatmap
// Signed RGB L1 overlap. Static rendering differences cancel; missing/opposite changes score 0.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
func load(_ p: String) -> CGImage {
  guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath:p) as CFURL,nil), let i = CGImageSourceCreateImageAtIndex(s,0,nil) else { fatalError("cannot read \(p)") }; return i
}
func context(_ w:Int,_ h:Int)->CGContext { CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:w*4,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)! }
let images = (1...4).map { load(CommandLine.arguments[$0]) }
let w=images[0].width,h=images[0].height
// Reject dimension changes instead of inventing state deltas through resampling.
guard images.allSatisfy({ $0.width == w && $0.height == h }) else { fatalError("state captures must have identical pixel dimensions") }
let contexts=images.map { image -> CGContext in let c=context(w,h); c.draw(image,in:CGRect(x:0,y:0,width:w,height:h)); return c }
let pixels=contexts.map { $0.data!.assumingMemoryBound(to:UInt8.self) }
struct Region {
 var reference=0, native=0, error=0, missing=0, unexpected=0, changed=0
 var score:Double { reference+native == 0 ? 0 : max(0,100*(1-Double(error)/Double(reference+native))) }
 mutating func add(_ ra:Int,_ rb:Int,_ difference:Int) {
  reference += ra; native += rb; error += difference
  if ra > 0 || rb > 0 { changed += 1 }
  if ra > 0 && rb == 0 { missing += 1 }; if rb > 0 && ra == 0 { unexpected += 1 }
 }
 func json()->[String:Any] { ["score":score,"referenceEnergy":reference,"nativeEnergy":native,"changedPixels":changed,"missingPixels":missing,"unexpectedPixels":unexpected] }
}
var uniform = Array(repeating:true,count:4)
let tile=128, cols=(w+tile-1)/tile, rows=(h+tile-1)/tile
var regions=Array(repeating:Region(),count:cols*rows), total=Region()
let heat=context(w,h), out=heat.data!.assumingMemoryBound(to:UInt8.self)
for y in 0..<h { for x in 0..<w {
 let i=(y*w+x)*4
 for n in 0..<4 where uniform[n] { if pixels[n][i] != pixels[n][0] || pixels[n][i+1] != pixels[n][1] || pixels[n][i+2] != pixels[n][2] { uniform[n]=false } }
 let a0=Int(pixels[1][i])-Int(pixels[0][i]), a1=Int(pixels[1][i+1])-Int(pixels[0][i+1]), a2=Int(pixels[1][i+2])-Int(pixels[0][i+2])
 let b0=Int(pixels[3][i])-Int(pixels[2][i]), b1=Int(pixels[3][i+1])-Int(pixels[2][i+1]), b2=Int(pixels[3][i+2])-Int(pixels[2][i+2])
 let ra=abs(a0)+abs(a1)+abs(a2), rb=abs(b0)+abs(b1)+abs(b2)
 let e0=abs(a0-b0),e1=abs(a1-b1),e2=abs(a2-b2),difference=e0+e1+e2
 total.add(ra,rb,difference); regions[(y/tile)*cols+x/tile].add(ra,rb,difference)
 let err=max(e0,e1,e2)
 // Red: missing; blue: unexpected; orange: wrong magnitude/color; green: matched.
 let strength=UInt8(min(255,40+err*16))
 let color:(UInt8,UInt8,UInt8) = ra == 0 && rb == 0 ? (18,18,18) : rb == 0 ? (strength,0,0) : ra == 0 ? (0,80,strength) : err > 0 ? (strength,100,0) : (0,160,60)
 out[i]=color.0; out[i+1]=color.1; out[i+2]=color.2; out[i+3]=255
} }
let dest=CGImageDestinationCreateWithURL(URL(fileURLWithPath:CommandLine.arguments[5]) as CFURL,UTType.png.identifier as CFString,1,nil)!
CGImageDestinationAddImage(dest,heat.makeImage()!,nil); CGImageDestinationFinalize(dest)
// Tiny raster/caret noise is still reported but does not decide the regional verdict.
let active=regions.enumerated().filter { $0.element.changed >= 16 && $0.element.reference+$0.element.native >= 96 }
let worst=active.map { $0.element.score }.min() ?? 0
var result=total.json()
result["worstRegionScore"]=worst
result["verdict"]=total.reference < 96 ? "INCONCLUSIVE" : total.score >= 85 && worst >= 70 ? "PASS" : "FAIL"
if CommandLine.arguments.contains("--ui") && uniform.contains(true) { result["verdict"]="INVALID_CAPTURE" }
result["uniformInputs"]=uniform
result["regions"]=active.map { index,r -> [String:Any] in var j=r.json(); j["x"]=(index%cols)*tile; j["y"]=(index/cols)*tile; j["width"]=min(tile,w-(index%cols)*tile); j["height"]=min(tile,h-(index/cols)*tile); return j }
print(String(data:try! JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]),encoding:.utf8)!)
