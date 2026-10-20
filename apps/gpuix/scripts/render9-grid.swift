// swift render9-grid.swift out.png x y w h cols [top:N] a.png [top:N] b.png ...
// Crops each image to (x, y + top, w, h) pixels (`top:` = that image's title bar height in pixels) and lays the crops
// out row-major, `cols` per row, on a grey background: the desktop row over the GPUIX row for motion strips.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
var args = Array(CommandLine.arguments.dropFirst())
let out = args.removeFirst()
let x = Int(args.removeFirst())!, y = Int(args.removeFirst())!, w = Int(args.removeFirst())!, h = Int(args.removeFirst())!, cols = Int(args.removeFirst())!
var crops: [CGImage] = []; var top = 0
for a in args {
  if a.hasPrefix("top:") { top = Int(a.dropFirst(4))!; continue }
  guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: a) as CFURL, nil), let i = CGImageSourceCreateImageAtIndex(s, 0, nil) else { fatalError("cannot read \(a)") }
  crops.append(i.cropping(to: CGRect(x: x, y: y + top, width: w, height: h))!); top = 0
}
let gap = 8, rows = (crops.count + cols - 1) / cols
let W = cols * w + (cols - 1) * gap, H = rows * h + (rows - 1) * gap
let c = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
c.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1)); c.fill(CGRect(x: 0, y: 0, width: W, height: H))
for (n, i) in crops.enumerated() {
  let col = n % cols, row = n / cols
  c.draw(i, in: CGRect(x: col * (w + gap), y: H - (row + 1) * h - row * gap, width: w, height: h))
}
let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(d, c.makeImage()!, nil); CGImageDestinationFinalize(d)
