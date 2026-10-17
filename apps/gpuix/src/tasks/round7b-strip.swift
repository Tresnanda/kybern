// Matching list carry/cancel samples: desktop frontend in WebKit above GPUIX.
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers
let a = CommandLine.arguments
let width = 940, height = 700, gap = 4, label = 26
let ctx = CGContext(data:nil,width:(width+gap)*4,height:(height+label+gap)*2,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.setFillColor(CGColor(gray:0.12,alpha:1));ctx.fill(CGRect(x:0,y:0,width:ctx.width,height:ctx.height))
ctx.interpolationQuality = .high
for (index,file) in a.dropFirst(3).enumerated() {
 let source=CGImageSourceCreateWithURL(URL(fileURLWithPath:file) as CFURL,nil)!
 let image=CGImageSourceCreateImageAtIndex(source,0,nil)!
 let scale=CGFloat(image.width)/1280
 let piece=image.cropping(to:CGRect(x:320*scale,y:84*scale,width:CGFloat(width)*scale,height:CGFloat(height)*scale))!
 let x=(index%4)*(width+gap), y=(1-index/4)*(height+label+gap)
 ctx.draw(piece,in:CGRect(x:x,y:y,width:width,height:height))
 let engine=index<4 ? "Desktop frontend in WebKit" : "GPUIX native"
 let text="\(engine) · \(a[2]) · sample \(index%4+1)"
 let attrs:[NSAttributedString.Key:Any]=[NSAttributedString.Key(kCTFontAttributeName as String):CTFontCreateWithName("Helvetica" as CFString,15,nil),NSAttributedString.Key(kCTForegroundColorAttributeName as String):CGColor(gray:1,alpha:1)]
 let line=CTLineCreateWithAttributedString(NSAttributedString(string:text,attributes:attrs))
 ctx.textPosition=CGPoint(x:x+8,y:y+height+7);CTLineDraw(line,ctx)
}
let destination=CGImageDestinationCreateWithURL(URL(fileURLWithPath:a[1]) as CFURL,UTType.png.identifier as CFString,1,nil)!
CGImageDestinationAddImage(destination,ctx.makeImage()!,nil);CGImageDestinationFinalize(destination)
