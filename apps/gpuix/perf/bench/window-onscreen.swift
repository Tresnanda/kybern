import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let test = (try? String(contentsOfFile: "/tmp/kybern-gpuix-test-display", encoding: .utf8)).flatMap { UInt32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
let area = test.map { CGDisplayBounds($0) } ?? .zero
let scale = test.map { Double(CGDisplayPixelsWide($0)) / max(1, area.width) } ?? 0
let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
let on = Set((CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]).compactMap { $0[kCGWindowNumber as String] as? Int })
for w in all where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  let n = w[kCGWindowNumber as String] as! Int
  let bounds = CGRect(dictionaryRepresentation: w[kCGWindowBounds as String] as! CFDictionary)!
  let windowScale = area.contains(bounds) ? scale : 0
  print("window \(n) onscreen=\(on.contains(n)) scale=\(windowScale) bounds=\(w[kCGWindowBounds as String]!)")
}
