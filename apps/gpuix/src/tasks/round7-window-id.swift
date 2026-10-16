// Fixture windows use level 3 to remain visible without activation. Match only
// this owned PID, then its largest window, including that nonzero level.
// swift window-id.swift <pid>  — prints the CGWindowID of the largest on-screen window owned by <pid>.
import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
var best: (Int, Double) = (0, 0)
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
  let area = (b["Width"] ?? 0) * (b["Height"] ?? 0)
  if area > best.1 { best = (w[kCGWindowNumber as String] as! Int, area) }
}
if best.0 == 0 { exit(1) }
print(best.0)
