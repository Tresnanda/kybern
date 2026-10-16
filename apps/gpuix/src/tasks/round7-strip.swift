// Four matching input/settle samples. Tauri WebKit above, native GPUIX below.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
let a=CommandLine.arguments
let width=500,height=420,gap=4
let ctx=CGContext(data:nil,width:(width+gap)*4,height:(height+gap)*2,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.interpolationQuality = .high
for (index,file) in a.dropFirst(2).enumerated(){
 let source=CGImageSourceCreateWithURL(URL(fileURLWithPath:file) as CFURL,nil)!
 let image=CGImageSourceCreateImageAtIndex(source,0,nil)!
 let scale=CGFloat(image.width)/1280
 let piece=image.cropping(to:CGRect(x:300*scale,y:84*scale,width:CGFloat(width)*scale,height:CGFloat(height)*scale))!
 ctx.draw(piece,in:CGRect(x:(index%4)*(width+gap),y:(1-index/4)*(height+gap),width:width,height:height))
}
let destination=CGImageDestinationCreateWithURL(URL(fileURLWithPath:a[1]) as CFURL,UTType.png.identifier as CFString,1,nil)!
CGImageDestinationAddImage(destination,ctx.makeImage()!,nil);CGImageDestinationFinalize(destination)
