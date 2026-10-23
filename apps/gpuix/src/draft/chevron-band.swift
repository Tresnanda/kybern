// swift chevron-band.swift img.png x y w h splitX (pixels): where the hero name's lowercase body (rows denser than half the
// densest row) and the chevron's ink sit, and the visible gap between them. Run by `verify.ts` on the 2× captures.
import CoreGraphics; import Foundation; import ImageIO
let a = CommandLine.arguments
let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil)!
let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
let (x0, y0, w, h, split) = (Int(a[2])!, Int(a[3])!, Int(a[4])!, Int(a[5])!, Int(a[6])!)
let W = img.width, H = img.height
var buf = [UInt8](repeating: 0, count: W * H * 4)
let ctx = CGContext(data: &buf, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
func lum(_ x: Int, _ y: Int) -> Double { let i = (y * W + x) * 4; return 0.299 * Double(buf[i]) + 0.587 * Double(buf[i+1]) + 0.114 * Double(buf[i+2]) }
// background = top-left pixel of the region
let bg = lum(x0, y0)
var text = [Int](repeating: 0, count: h), chev = [Int](repeating: 0, count: h)
var textRight = 0, chevLeft = Int.max, chevRight = 0
for y in 0..<h { for x in 0..<w { let d = abs(lum(x0 + x, y0 + y) - bg); if d > 40 { if x0 + x < split { text[y] += 1; textRight = max(textRight, x0 + x) } else { chev[y] += 1; chevLeft = min(chevLeft, x0 + x); chevRight = max(chevRight, x0 + x) } } } }
let mx = text.max()!
let band = (0..<h).filter { text[$0] > mx / 2 }
let ink = (0..<h).filter { text[$0] > 0 }
let cv = (0..<h).filter { chev[$0] > 0 }
let wsum = cv.reduce(0.0) { $0 + Double($1) * Double(chev[$1]) }, wn = cv.reduce(0.0) { $0 + Double(chev[$1]) }
print("text ink rows \(ink.first!)…\(ink.last!), x-band \(band.first!)…\(band.last!) centre \(Double(band.first! + band.last!) / 2)")
print("chevron rows \(cv.first!)…\(cv.last!) box centre \(Double(cv.first! + cv.last!) / 2) ink centre \(wsum / wn)")
print("text right \(textRight) chevron \(chevLeft)…\(chevRight) gap \(chevLeft - textRight - 1)px")
