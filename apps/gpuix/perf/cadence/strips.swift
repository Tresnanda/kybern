// App-only real-clock captures, assembled separately from resource windows.
import AppKit
import ImageIO
let root=URL(fileURLWithPath:"/Users/mymac/projects/ade/previews/gpuix/perf/cadence/loops")
let out=root.deletingLastPathComponent().appendingPathComponent("strips")
try FileManager.default.createDirectory(at:out,withIntermediateDirectories:true)
func load(_ url:URL)->CGImage {CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(url as CFURL,nil)!,0,nil)!}
func rgba(_ image:CGImage)->[UInt8] {
 var bytes=[UInt8](repeating:0,count:image.width*image.height*4)
 bytes.withUnsafeMutableBytes { buffer in
  let ctx=CGContext(data:buffer.baseAddress,width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:image.width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height))
 }
 return bytes
}
var comparisons=[[String:Any]](),count=0
for mode in ["default","native"] {for scene in ["matrix","spin","connection","task","shimmer","skeleton","visual","elapsed","caret"] {for theme in ["dark","light"] {for reduced in ["0","1"] {
 let names=["before","after"].map { source in (0..<8).map {root.appendingPathComponent("\(source)-\(mode)-\(scene)-\(theme)-\(reduced)-\($0).png")} }
 if !names.flatMap({$0}).allSatisfy({FileManager.default.fileExists(atPath:$0.path)}) {continue}
 let width=["matrix":260,"spin":100,"connection":100,"task":100,"shimmer":440,"skeleton":340,"visual":340,"elapsed":180,"caret":480][scene]!
 let columns=width>200 ? 4:8,rows=8/columns,height=2*(rows*110+24)
 let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:width*columns,pixelsHigh:height,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
 NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
 (theme=="light" ? NSColor(calibratedWhite:0.98,alpha:1):NSColor(calibratedWhite:0.1255,alpha:1)).setFill()
 NSBezierPath(rect:NSRect(x:0,y:0,width:width*columns,height:height)).fill()
 var firstCrops=[CGImage]()
 for source in 0..<2 {
  let top=source*(rows*110+24)
  let title="\(["before","after"][source]) · \(scene) · \(mode) · \(theme) · reduced=\(reduced)"
  (title as NSString).draw(at:NSPoint(x:8,y:height-top-20),withAttributes:[.font:NSFont.systemFont(ofSize:13),.foregroundColor:theme=="light" ? NSColor.black:NSColor.white])
  for (index,file) in names[source].enumerated() {autoreleasepool {
   let image=load(file),scale=Double(image.width)/720
   let ns=NSImage(cgImage:image,size:NSSize(width:image.width,height:image.height))
   let from=NSRect(x:24*scale,y:Double(image.height)-170*scale,width:Double(width)*scale,height:110*scale)
   let dest=NSRect(x:(index%columns)*width,y:height-top-24-(index/columns+1)*110,width:width,height:110)
   ns.draw(in:dest,from:from,operation:.copy,fraction:1,respectFlipped:false,hints:nil)
   if index==0 {firstCrops.append(image.cropping(to:CGRect(x:24*scale,y:60*scale,width:Double(width)*scale,height:110*scale))!)}
  }}
 }
 NSGraphicsContext.restoreGraphicsState()
 let target=out.appendingPathComponent("\(mode)-\(scene)-\(theme)-reduced\(reduced).png")
 try bitmap.representation(using:.png,properties:[:])!.write(to:target);count+=1
 if reduced=="1" && scene != "elapsed" && scene != "skeleton" {
  let a=rgba(firstCrops[0]),b=rgba(firstCrops[1]);var changed=0
  if a.count==b.count {for i in stride(from:0,to:a.count,by:4) {if a[i] != b[i] || a[i+1] != b[i+1] || a[i+2] != b[i+2] {changed+=1}}}
  else {changed = -1}
  comparisons.append(["scene":scene,"mode":mode,"theme":theme,"changedPixels":changed,"strip":target.path])
 }
}}}}
try JSONSerialization.data(withJSONObject:comparisons,options:[.prettyPrinted,.sortedKeys]).write(to:out.appendingPathComponent("static-comparisons.json"))
print("\(count) strips; static differences require visual review")
