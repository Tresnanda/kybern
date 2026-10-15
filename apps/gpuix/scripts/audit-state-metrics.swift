// Compare interaction screenshots with their base, independently per renderer.
import AppKit
func rgba(_ path: String) -> (Int, Int, [UInt8])? {
 guard let image=NSImage(contentsOfFile:path), let cg=image.cgImage(forProposedRect:nil,context:nil,hints:nil) else {return nil}
 let w=cg.width,h=cg.height;var bytes=[UInt8](repeating:0,count:w*h*4)
 let ok=bytes.withUnsafeMutableBytes { p -> Bool in
  guard let context=CGContext(data:p.baseAddress,width:w,height:h,bitsPerComponent:8,bytesPerRow:w*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else{return false}
  context.draw(cg,in:CGRect(x:0,y:0,width:w,height:h));return true
 }
 return ok ? (w,h,bytes):nil
}
guard CommandLine.arguments.count==3,let a=rgba(CommandLine.arguments[1]),let b=rgba(CommandLine.arguments[2]),a.0==b.0,a.1==b.1 else {print("unavailable");exit(1)}
var exact=0,threshold=0
for i in stride(from:0,to:a.2.count,by:4){let d=max(abs(Int(a.2[i])-Int(b.2[i])),abs(Int(a.2[i+1])-Int(b.2[i+1])),abs(Int(a.2[i+2])-Int(b.2[i+2])));if d>0{exact+=1};if d>24{threshold+=1}}
print(String(format:"{\"changedPixels\":%d,\"over24Pixels\":%d,\"over24Percent\":%.6f,\"pixels\":%d}",exact,threshold,Double(threshold)*100/Double(a.0*a.1),a.0*a.1))
