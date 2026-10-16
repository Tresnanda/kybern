// swift scripts/drag-sheet.swift out.png tauriDir gpuixDir x y w h 0,3,6,... [labels]
// One row per app (Tauri on top, GPUIX below) of the same region (CSS px) in the chosen strip frames.
// Tauri strips are 1x, GPUIX strips 2x; both are drawn at 1x so a drag fits one sheet.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
func load(_ p: String) -> CGImage? { CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) } }
let a = CommandLine.arguments
let x = CGFloat(Double(a[4])!), y = CGFloat(Double(a[5])!), w = CGFloat(Double(a[6])!), h = CGFloat(Double(a[7])!)
let frames = a[8].split(separator: ",").map { String(format: "%02d", Int($0)!) }
let gap: CGFloat = 4
let W = Int((w + gap) * CGFloat(frames.count)), H = Int((h + gap) * 2)
let c = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
c.setFillColor(CGColor(red: 0.9, green: 0.2, blue: 0.2, alpha: 1)); c.fill(CGRect(x: 0, y: 0, width: W, height: H))
c.interpolationQuality = .high
for (row, dir) in [a[2], a[3]].enumerated() {
  for (col, f) in frames.enumerated() {
    guard let img = load("\(dir)/\(f).png") else { continue }
    let s = CGFloat(img.width) / 1280
    let piece = img.cropping(to: CGRect(x: x * s, y: y * s, width: w * s, height: h * s))!
    c.draw(piece, in: CGRect(x: CGFloat(col) * (w + gap), y: CGFloat(1 - row) * (h + gap), width: w, height: h))
  }
}
let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(d, c.makeImage()!, nil); CGImageDestinationFinalize(d)
