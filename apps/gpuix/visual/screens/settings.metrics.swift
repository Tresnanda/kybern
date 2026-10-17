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
// Whole-frame metrics, plus a conservative Changes diff+frame region.
// Region contributions are percentage points of the whole frame, not causal attribution.
let folder = CommandLine.arguments[1]
let files = try FileManager.default.contentsOfDirectory(atPath: folder).filter { $0.hasSuffix("-tauri.png") }.sorted()
for file in files {
  let base = String(file.dropLast("-tauri.png".count))
  let other = folder + "/" + base + "-gpuix.png"
  if !FileManager.default.fileExists(atPath: other) { continue }
  let a = load(folder + "/" + file), b = load(other)
  let w = a.width, h = a.height
  let ac = ctx(w,h), bc = ctx(w,h)
  ac.draw(a,in:CGRect(x:0,y:0,width:w,height:h)); bc.interpolationQuality = .high; bc.draw(b,in:CGRect(x:0,y:0,width:w,height:h))
  let pa = ac.data!.assumingMemoryBound(to:UInt8.self), pb = bc.data!.assumingMemoryBound(to:UInt8.self)
  var total = 0, region = 0
  for y in 0..<h { for x in 0..<w {
    let i = y * ac.bytesPerRow + x * 4
    let diff = max(abs(Int(pa[i])-Int(pb[i])),abs(Int(pa[i+1])-Int(pb[i+1])),abs(Int(pa[i+2])-Int(pb[i+2])))
    if diff > 24 {
      total += 1
      // Union of the visible native diff frames; x>=646, y>=110 logical.
      // Includes differing app-side offsets/header; decoded bitmap rows start at the top.
      let lx = Double(x)*1280/Double(w), ly = Double(y)*820/Double(h)
      if base.hasPrefix("pulls-changes-") && lx >= 646 && lx < 1256 && ly >= 110 && ly < 808 { region += 1 }
    }
  }}
  let denominator = Double(w*h)/100
  print(String(format:"%@ whole=%.2f%% diff-region=%.2fpp outside=%.2fpp",base,Double(total)/denominator,Double(region)/denominator,Double(total-region)/denominator))
}
