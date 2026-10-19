import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
// GPUIX measurement fixtures use nonzero window levels without activation.
let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
let on = Set((CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]).compactMap { $0[kCGWindowNumber as String] as? Int })
for w in all where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  let n = w[kCGWindowNumber as String] as! Int
  print("window \(n) onscreen=\(on.contains(n)) bounds=\(w[kCGWindowBounds as String]!)")
}
