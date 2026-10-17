// swift compose.swift tauri.png gpuix.png pair.png diff.png
// Side-by-side composite (Tauri left, GPUIX right) and a pixel-difference heatmap.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func load(_ p: String) -> CGImage {
  guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil), let i = CGImageSourceCreateImageAtIndex(s, 0, nil) else { fatalError("cannot read \(p)") }
  return i
}
func save(_ c: CGContext, _ p: String) {
  let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: p) as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(d, c.makeImage()!, nil); CGImageDestinationFinalize(d)
}
func ctx(_ w: Int, _ h: Int) -> CGContext {
  CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}
let threshold = CommandLine.arguments.count > 5 ? Int(CommandLine.arguments[5])! : 24
let a = load(CommandLine.arguments[1]), b = load(CommandLine.arguments[2])
let w = a.width, h = a.height
// Normalise GPUIX to the Tauri pixel size (both are 1280x820 logical).
let bs = ctx(w, h); bs.interpolationQuality = .high; bs.draw(b, in: CGRect(x: 0, y: 0, width: w, height: h))
let gap = 24
let pair = ctx(w * 2 + gap, h)
pair.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1)); pair.fill(CGRect(x: 0, y: 0, width: w * 2 + gap, height: h))
pair.draw(a, in: CGRect(x: 0, y: 0, width: w, height: h))
pair.draw(bs.makeImage()!, in: CGRect(x: w + gap, y: 0, width: w, height: h))
save(pair, CommandLine.arguments[3])
let ac = ctx(w, h); ac.draw(a, in: CGRect(x: 0, y: 0, width: w, height: h))
let pa = ac.data!.assumingMemoryBound(to: UInt8.self), pb = bs.data!.assumingMemoryBound(to: UInt8.self)
let d = ctx(w, h), pd = d.data!.assumingMemoryBound(to: UInt8.self)
let ra = ac.bytesPerRow, rd = d.bytesPerRow
var over = 0
for y in 0..<h { for x in 0..<w {
  let i = y * ra + x * 4, o = y * rd + x * 4
  let diff = max(abs(Int(pa[i]) - Int(pb[i])), abs(Int(pa[i+1]) - Int(pb[i+1])), abs(Int(pa[i+2]) - Int(pb[i+2])))
  let g = Int(pa[i]) / 4 + 20
  if diff > threshold { over += 1; pd[o] = 255; pd[o+1] = UInt8(max(0, 200 - diff)); pd[o+2] = 40; pd[o+3] = 255 }
  else { pd[o] = UInt8(g); pd[o+1] = UInt8(g); pd[o+2] = UInt8(g); pd[o+3] = 255 }
} }
save(d, CommandLine.arguments[4])
print(String(format: "%.2f%% pixels differ", Double(over) * 100 / Double(w * h)))
