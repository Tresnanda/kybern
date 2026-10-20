import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
var displays = [CGDirectDisplayID](repeating: 0, count: 16)
var displayCount: UInt32 = 0
CGGetActiveDisplayList(UInt32(displays.count), &displays, &displayCount)
let testId = UInt32((try? String(contentsOfFile: "/tmp/kybern-gpuix-test-display", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
let test = displays.prefix(Int(displayCount)).first { $0 == testId }
let scale = test.flatMap(CGDisplayCopyDisplayMode).map { Double($0.pixelWidth) / Double($0.width) } ?? 0
let bounds = test.map(CGDisplayBounds) ?? .zero
print("testActive=\(test != nil) testScale=\(scale) displayX=\(bounds.origin.x) displayY=\(bounds.origin.y) displayWidth=\(bounds.width) displayHeight=\(bounds.height)")
// GPUIX measurement fixtures use nonzero window levels without activation.
let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
let on = Set((CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]).compactMap { $0[kCGWindowNumber as String] as? Int })
for w in all where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  let n = w[kCGWindowNumber as String] as! Int
  print("window \(n) onscreen=\(on.contains(n)) bounds=\(w[kCGWindowBounds as String]!)")
}
