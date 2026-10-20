// swift accent-pixels.swift image.png x y w h r g b [tolerance]: how many pixels in the region (image pixels) are within
// `tolerance` (default 40, per channel) of the colour. Used to tell a decorated chip from plain text.
import CoreGraphics
import Foundation
import ImageIO
let a = Array(CommandLine.arguments.dropFirst())
let image = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(URL(fileURLWithPath: a[0]) as CFURL, nil)!, 0, nil)!
let (x, y, w, h) = (Int(a[1])!, Int(a[2])!, Int(a[3])!, Int(a[4])!)
let target = [Int(a[5])!, Int(a[6])!, Int(a[7])!], tolerance = a.count > 8 ? Int(a[8])! : 40
let crop = image.cropping(to: CGRect(x: x, y: y, width: w, height: h))!
var pixels = [UInt8](repeating: 0, count: w * h * 4)
let context = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
var count = 0
for i in stride(from: 0, to: pixels.count, by: 4) where abs(Int(pixels[i]) - target[0]) <= tolerance && abs(Int(pixels[i + 1]) - target[1]) <= tolerance && abs(Int(pixels[i + 2]) - target[2]) <= tolerance { count += 1 }
print(count)
