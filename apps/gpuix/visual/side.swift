// swift side.swift tauri.png gpuix.png out.png x y w h   (CSS px; images are @2x)
// Same region of both images side by side: Tauri left, GPUIX right.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
func load(_ p: String) -> CGImage { CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil)!, 0, nil)! }
let a = CommandLine.arguments
let x = Int(a[4])! * 2, y = Int(a[5])! * 2, w = Int(a[6])! * 2, h = Int(a[7])! * 2
func piece(_ i: CGImage) -> CGImage {
  let s = CGFloat(i.width) / 2560
  return i.cropping(to: CGRect(x: CGFloat(x) * s, y: CGFloat(y) * s, width: CGFloat(w) * s, height: CGFloat(h) * s))!
}
let c = CGContext(data: nil, width: w * 2 + 8, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
c.setFillColor(CGColor(red: 0.9, green: 0.2, blue: 0.2, alpha: 1)); c.fill(CGRect(x: 0, y: 0, width: w * 2 + 8, height: h))
c.interpolationQuality = .high
c.draw(piece(load(a[1])), in: CGRect(x: 0, y: 0, width: w, height: h))
c.draw(piece(load(a[2])), in: CGRect(x: w + 8, y: 0, width: w, height: h))
let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[3]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(d, c.makeImage()!, nil); CGImageDestinationFinalize(d)
