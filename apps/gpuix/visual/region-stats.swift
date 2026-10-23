// swift region-stats.swift image.png x y w h: the region's (image pixels) mean luma and its standard deviation, as JSON.
// A live visual drawn over the thread varies; an invisible (blank) one is the flat background.
import CoreGraphics
import Foundation
import ImageIO
let a = Array(CommandLine.arguments.dropFirst())
let image = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(URL(fileURLWithPath: a[0]) as CFURL, nil)!, 0, nil)!
let (x, y, w, h) = (Int(a[1])!, Int(a[2])!, Int(a[3])!, Int(a[4])!)
let crop = image.cropping(to: CGRect(x: x, y: y, width: w, height: h))!
var pixels = [UInt8](repeating: 0, count: w * h * 4)
let context = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
var sum = 0.0, squares = 0.0, n = 0.0
for i in stride(from: 0, to: pixels.count, by: 4) {
  let luma = 0.2126 * Double(pixels[i]) + 0.7152 * Double(pixels[i + 1]) + 0.0722 * Double(pixels[i + 2])
  sum += luma; squares += luma * luma; n += 1
}
let mean = sum / n
print("{\"mean\":\(mean),\"sd\":\(sqrt(max(0, squares / n - mean * mean)))}")
