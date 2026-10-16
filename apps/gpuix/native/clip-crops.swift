// Zoomed Tauri/GPUIX corner pairs from recorded logical window geometry.
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers
func load(_ file:String)->CGImage { let s=CGImageSourceCreateWithURL(URL(fileURLWithPath:file) as CFURL,nil)!;return CGImageSourceCreateImageAtIndex(s,0,nil)! }
func metadata(_ file:String)->[String:Any] {try! JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:file))) as! [String:Any]}
func box(_ value:Any)->CGRect {let b=value as! [String:Any];return CGRect(x:(b["x"] as! NSNumber).doubleValue,y:(b["y"] as! NSNumber).doubleValue,width:(b["width"] as! NSNumber).doubleValue,height:(b["height"] as! NSNumber).doubleValue)}
func context(_ w:Int,_ h:Int)->CGContext {CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!}
func save(_ c:CGContext,_ file:String){let d=CGImageDestinationCreateWithURL(URL(fileURLWithPath:file) as CFURL,UTType.png.identifier as CFString,1,nil)!;CGImageDestinationAddImage(d,c.makeImage()!,nil);CGImageDestinationFinalize(d)}
func text(_ value:String,_ c:CGContext,_ x:CGFloat,_ y:CGFloat){let attrs=[kCTFontAttributeName:CTFontCreateWithName("Menlo" as CFString,11,nil),kCTForegroundColorAttributeName:CGColor(gray:0.15,alpha:1)] as [CFString:Any];let line=CTLineCreateWithAttributedString(NSAttributedString(string:value,attributes:attrs as [NSAttributedString.Key:Any]));c.textPosition=CGPoint(x:x,y:y);CTLineDraw(line,c)}
func crop(_ image:CGImage,_ rect:CGRect,_ window:[String:Any])->CGImage {let s=CGFloat(image.width)/CGFloat((window["width"] as! NSNumber).doubleValue);let r=CGRect(x:rect.minX*s,y:rect.minY*s,width:rect.width*s,height:rect.height*s).integral.intersection(CGRect(x:0,y:0,width:image.width,height:image.height));return image.cropping(to:r)!}
let args=CommandLine.arguments,tauri=load(args[1]),gpuix=load(args[2]),tm=metadata(args[3]),gm=metadata(args[4]),prefix=args[5]
func corners(_ a:CGRect,_ b:CGRect,_ suffix:String){
 let out=context(396,848);out.setFillColor(CGColor(gray:0.94,alpha:1));out.fill(CGRect(x:0,y:0,width:396,height:848));out.interpolationQuality = .none
 let labels=["top left","top right","bottom left","bottom right"]
 for row in 0..<4 {for col in 0..<2 {
  let bounds=col==0 ? a:b,image=col==0 ? tauri:gpuix,m=col==0 ? tm:gm
  let r=CGRect(x:row%2==0 ? bounds.minX-8:bounds.maxX-40,y:row<2 ? bounds.minY-8:bounds.maxY-40,width:48,height:48)
  let y=CGFloat(3-row)*212
  out.draw(crop(image,r,m["window"] as! [String:Any]),in:CGRect(x:col*204,y:Int(y),width:192,height:192))
  text((col==0 ? "Tauri · ":"GPUIX · ")+labels[row],out,CGFloat(col*204),y+198)
 }}
 save(out,prefix+suffix)
}
corners(box(tm["workspace"]!),box(gm["workspace"]!),"-corners.png")
let th=tm["code"] as? [[String:Any]] ?? [],gh=(gm["codeHeaders"] as? [Any] ?? []).compactMap{$0 as? [String:Any]},gb=(gm["codeBodies"] as? [Any] ?? []).compactMap{$0 as? [String:Any]}
if !th.isEmpty && !gh.isEmpty && !gb.isEmpty {
 let last=prefix.contains("horizontal")||prefix.contains("wrapped"),ti=last ? th.count-1:0,gi=last ? min(gh.count,gb.count)-1:0
 let a=box(th[ti]),b=box(gh[gi]).union(box(gb[gi]))
 corners(a,b,"-code-corners.png")
 let ac=crop(tauri,a.insetBy(dx:-4,dy:-4),tm["window"] as! [String:Any]),bc=crop(gpuix,b.insetBy(dx:-4,dy:-4),gm["window"] as! [String:Any])
 let out=context(ac.width+bc.width+16,max(ac.height,bc.height)+24)
 out.setFillColor(CGColor(gray:0.94,alpha:1));out.fill(CGRect(x:0,y:0,width:out.width,height:out.height));out.interpolationQuality = .none
 out.draw(ac,in:CGRect(x:0,y:out.height-24-ac.height,width:ac.width,height:ac.height));out.draw(bc,in:CGRect(x:ac.width+16,y:out.height-24-bc.height,width:bc.width,height:bc.height))
 text("Tauri",out,0,CGFloat(out.height-16));text("GPUIX",out,CGFloat(ac.width+16),CGFloat(out.height-16));save(out,prefix+"-code.png")
}
