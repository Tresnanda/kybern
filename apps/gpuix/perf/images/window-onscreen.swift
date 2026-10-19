import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
var displays = [CGDirectDisplayID](repeating: 0, count: 16)
var displayCount: UInt32 = 0
CGGetActiveDisplayList(UInt32(displays.count), &displays, &displayCount)
let builtIn = displays.prefix(Int(displayCount)).first { CGDisplayIsBuiltin($0) != 0 }
let scale = builtIn.flatMap(CGDisplayCopyDisplayMode).map { Double($0.pixelWidth) / Double($0.width) } ?? 0
print("builtinActive=\(builtIn != nil) builtinScale=\(scale)")
// GPUIX measurement fixtures use nonzero window levels without activation.
let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
let on = Set((CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]).compactMap { $0[kCGWindowNumber as String] as? Int })
for w in all where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  let n = w[kCGWindowNumber as String] as! Int
  print("window \(n) onscreen=\(on.contains(n)) bounds=\(w[kCGWindowBounds as String]!)")
}
