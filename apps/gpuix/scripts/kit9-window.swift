// swift kit9-window.swift <pid> — prints "id x y w h" of the largest layer-0 on-screen window of <pid>.
import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
var best: (Int, [String: Double], Double) = (0, [:], 0)
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
  let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
  let area = (b["Width"] ?? 0) * (b["Height"] ?? 0)
  if area > best.2 { best = (w[kCGWindowNumber as String] as! Int, b, area) }
}
if best.0 == 0 { exit(1) }
print("\(best.0) \(best.1["X"]!) \(best.1["Y"]!) \(best.1["Width"]!) \(best.1["Height"]!)")
