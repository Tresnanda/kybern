// swift kanban10-edges.swift hold.png after.png x y0 y1 — card edges (luminance steps ≥ 3) down the vertical line x
// (window points) in two captures of the same window, and the edges of `after` that `hold` does not have within 0.5 pt.
// Held edges count from a step of 1: the dimmed source (opacity .35) has the same edges at lower contrast.
import CoreGraphics
import Foundation
import ImageIO
let a = CommandLine.arguments
func edges(_ file: String, _ step: Int) -> [Double] {
  let img = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }!
  let s = Double(img.width) / 1280, W = img.width, H = img.height
  let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
  let p = ctx.data!.bindMemory(to: UInt8.self, capacity: W * H * 4)
  let x = Int(Double(a[3])! * s)
  var out: [Double] = [], last = -1
  for y in Int(Double(a[4])! * s)..<min(H, Int(Double(a[5])! * s)) {
    let i = (y * W + x) * 4, l = (Int(p[i]) + Int(p[i + 1]) + Int(p[i + 2])) / 3
    if last >= 0 && abs(l - last) >= step { out.append(Double(y) / s) }
    last = l
  }
  return out
}
let hold = edges(a[1], 1), after = edges(a[2], 3)
let missing = after.filter { e in !hold.contains { abs($0 - e) <= 0.5 } }
print("hold", hold.map { String($0) }.joined(separator: " "))
print("after", after.map { String($0) }.joined(separator: " "))
print("missing", missing.map { String($0) }.joined(separator: " "))
