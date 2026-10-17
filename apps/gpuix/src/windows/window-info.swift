// swift window-info.swift <pid>… — one JSON line per on-screen layer-0 window of those processes, front to back:
// {"pid","id","title","x","y","w","h"}. Titles need Screen Recording permission for the calling process.
import CoreGraphics
import Foundation
let pids = Set(CommandLine.arguments.dropFirst().compactMap { Int32($0) })
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  guard let pid = w[kCGWindowOwnerPID as String] as? Int32, pids.contains(pid), (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
  let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
  let item: [String: Any] = ["pid": pid, "id": w[kCGWindowNumber as String] as? Int ?? 0, "title": w[kCGWindowName as String] as? String ?? "", "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0]
  print(String(data: try! JSONSerialization.data(withJSONObject: item), encoding: .utf8)!)
}
