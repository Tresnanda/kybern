// swift stack.swift out.png top:<cropTopPx> img1.png [top:<px>] img2.png ...  — stack images vertically (each cropped
// from the top by the preceding `top:` pixels, e.g. a window title bar), separated by a grey gap. Evidence helper.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
var args = Array(CommandLine.arguments.dropFirst()); let out = args.removeFirst()
var images: [CGImage] = []; var top = 0
for a in args {
  if a.hasPrefix("top:") { top = Int(a.dropFirst(4))!; continue }
  guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: a) as CFURL, nil), let i = CGImageSourceCreateImageAtIndex(s, 0, nil) else { fatalError("cannot read \(a)") }
  images.append(i.cropping(to: CGRect(x: 0, y: top, width: i.width, height: i.height - top))!); top = 0
}
let gap = 12, w = images.map(\.width).max()!, h = images.map(\.height).reduce(0, +) + gap * (images.count - 1)
let c = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
c.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1)); c.fill(CGRect(x: 0, y: 0, width: w, height: h))
var y = h
for i in images { y -= i.height; c.draw(i, in: CGRect(x: 0, y: y, width: i.width, height: i.height)); y -= gap }
let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(d, c.makeImage()!, nil); CGImageDestinationFinalize(d)
