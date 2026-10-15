// Verify a Settings search top border in the screenshots from visual-focus-check.ts.
import Foundation
import CoreGraphics
import ImageIO
let dir = CommandLine.arguments[1]
let bounds = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: dir + "/bounds.json"))) as! [String: Double]
let names = ["blur-before", "click", "blur-after-click", "api-focus", "blur-after-api", "tab", "blur-after-tab"]
var values: [String: Int] = [:]
for name in names {
 let im = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(URL(fileURLWithPath: dir + "/" + name + ".png") as CFURL, nil)!, 0, nil)!
 let c = CGContext(data: nil, width: im.width, height: im.height, bitsPerComponent: 8, bytesPerRow: im.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
 c.draw(im, in: CGRect(x: 0, y: 0, width: im.width, height: im.height))
 let pixels = c.data!.assumingMemoryBound(to: UInt8.self)
 let x = Int((bounds["x"]! + bounds["width"]! / 2) * 2)
 let y = Int((bounds["y"]! - 0.5) * 2)
 values[name] = Int(pixels[(y * im.width + x) * 4])
}
print(String(data: try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]), encoding: .utf8)!)
let idle = values["blur-before"]!
for name in ["click", "api-focus", "tab"] { guard values[name]! > idle + 20 else { fputs("FAIL: \(name) did not brighten the border\n", stderr); exit(1) } }
for name in ["blur-after-click", "blur-after-api", "blur-after-tab"] { guard abs(values[name]! - idle) <= 2 else { fputs("FAIL: \(name) did not clear the border\n", stderr); exit(1) } }
print("PASS: click, renderer focus, keyboard Tab, and blur border pixels")
