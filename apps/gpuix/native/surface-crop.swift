import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
let a=CommandLine.arguments
let image=CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(URL(fileURLWithPath:a[1]) as CFURL,nil)!,0,nil)!
let scale=Double(image.width)/728.0, height=Int(Double(a.count>3 ? a[3] : "600")!*scale)
let crop=image.cropping(to:CGRect(x:0,y:image.height-height,width:image.width,height:height))!
let out=CGImageDestinationCreateWithURL(URL(fileURLWithPath:a[2]) as CFURL,UTType.png.identifier as CFString,1,nil)!
CGImageDestinationAddImage(out,crop,nil);CGImageDestinationFinalize(out)
