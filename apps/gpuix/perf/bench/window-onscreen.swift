import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let test = (try? String(contentsOfFile: "/tmp/kybern-gpuix-test-display", encoding: .utf8)).flatMap { UInt32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
let area = test.map { CGDisplayBounds($0) } ?? .zero
// CGDisplayPixelsWide reports logical width on this virtual HiDPI display.
let mode = test.flatMap { CGDisplayCopyDisplayMode($0) }
let scale = mode.map { Double($0.pixelWidth) / Double(max(1, $0.width)) } ?? 0
print("test-display \(test ?? 0) scale=\(scale) bounds=\(area.dictionaryRepresentation)")
let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
let on = Set((CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]).compactMap { $0[kCGWindowNumber as String] as? Int })
for w in all where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  let n = w[kCGWindowNumber as String] as! Int
  let bounds = CGRect(dictionaryRepresentation: w[kCGWindowBounds as String] as! CFDictionary)!
  let windowScale = area.contains(bounds) ? scale : 0
  print("window \(n) onscreen=\(on.contains(n)) scale=\(windowScale) bounds=\(w[kCGWindowBounds as String]!)")
}
