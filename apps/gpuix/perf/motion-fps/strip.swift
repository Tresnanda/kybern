// Assemble a horizontal frame strip from window captures: crop (window points) each PNG, scale 4x nearest.
//   swift perf/motion-fps/strip.swift <out.png> <x> <y> <w> <h> <frame.png...>
import AppKit
let a = CommandLine.arguments
let crop = CGRect(x: Double(a[2])! * 2, y: Double(a[3])! * 2, width: Double(a[4])! * 2, height: Double(a[5])! * 2)
let frames = a.dropFirst(6).compactMap { NSImage(contentsOfFile: $0)?.cgImage(forProposedRect: nil, context: nil, hints: nil)?.cropping(to: crop) }
let zoom = 4, gap = 8, w = Int(crop.width) * zoom, h = Int(crop.height) * zoom
let ctx = CGContext(data: nil, width: frames.count * (w + gap), height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.interpolationQuality = .none
ctx.setFillColor(CGColor(red: 1, green: 0, blue: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: frames.count * (w + gap), height: h))
for (i, f) in frames.enumerated() { ctx.draw(f, in: CGRect(x: i * (w + gap), y: 0, width: w, height: h)) }
let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[1]))
print("strip \(frames.count) frames -> \(a[1])")
