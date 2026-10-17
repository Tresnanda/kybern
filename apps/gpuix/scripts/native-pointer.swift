// Real AppKit pointer input, only after verifying the target lab owns the hit window.
import Foundation
import CoreGraphics
guard CGPreflightPostEventAccess() else { print("BLOCKED: grant this terminal Accessibility permission to run the real pointer check"); exit(2) }
let pid = pid_t(CommandLine.arguments[1])!
let localX = Double(CommandLine.arguments[2])!
let localY = Double(CommandLine.arguments[3])!
let contentHeight = Double(CommandLine.arguments[4])!
let zoom = CommandLine.arguments.last == "zoom"
func windows() -> [[String: Any]] { CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? [] }
func rect(_ w: [String: Any]) -> CGRect { CGRect(dictionaryRepresentation: w[kCGWindowBounds as String] as! CFDictionary)! }
func frame() -> CGRect? { windows().first { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 && rect($0).width > 200 }.map(rect) }
func stableFrame() -> CGRect? {
    let deadline = Date().addingTimeInterval(5)
    var last = frame(); var stable = Date()
    while Date() < deadline {
        Thread.sleep(forTimeInterval: 0.03)
        let next = frame()
        if next != last { stable = Date(); last = next }
        if next != nil && Date().timeIntervalSince(stable) > 0.3 { return next }
    }
    return last
}
func send(_ type: CGEventType, _ p: CGPoint, clicks: Int64 = 1) {
    let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
    event.setIntegerValueField(.mouseEventClickState, value: clicks)
    event.post(tap: .cghidEventTap)
}
guard let before = stableFrame() else { print("FAIL missing lab window"); exit(1) }
let start = CGPoint(x: before.minX + localX, y: before.minY + before.height - contentHeight + localY)
guard let hit = windows().first(where: { ($0[kCGWindowLayer as String] as? Int) == 0 && rect($0).contains(start) }), (hit[kCGWindowOwnerPID as String] as? Int) == Int(pid) else { print("FAIL lab window is covered; refusing pointer input"); exit(1) }
send(.mouseMoved, start)
if !zoom {
    send(.leftMouseDown, start)
    send(.leftMouseUp, start)
    _ = stableFrame()
}
if zoom {
    send(.leftMouseDown, start, clicks: 2)
    send(.leftMouseUp, start, clicks: 2)
} else {
    send(.leftMouseDown, start)
    for i in 1...12 {
        Thread.sleep(forTimeInterval: 0.02)
        send(.leftMouseDragged, CGPoint(x: start.x + Double(i) * 5, y: start.y + Double(i) * 3))
    }
    send(.leftMouseUp, CGPoint(x: start.x + 60, y: start.y + 36))
}
guard let after = stableFrame() else { print("FAIL lab window disappeared"); exit(1) }
let changed = zoom ? after.size != before.size : abs(after.minX - before.minX - 60) < 3 && abs(after.minY - before.minY - 36) < 3 && after.size == before.size
print("\(changed ? "ok" : "FAIL") real pointer \(zoom ? "zoom" : "drag"): \(before) → \(after), click \(start)")
exit(changed ? 0 : 1)
