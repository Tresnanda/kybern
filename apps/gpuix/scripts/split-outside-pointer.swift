// Real AppKit pointer input, only after verifying the target lab owns the hit window.
import Foundation
import CoreGraphics
import AppKit
guard CGPreflightPostEventAccess() else { print("BLOCKED: grant this terminal Accessibility permission to run the real pointer check"); exit(2) }
let pid = pid_t(CommandLine.arguments[1])!
let localX = Double(CommandLine.arguments[2])!
let localY = Double(CommandLine.arguments[3])!
let contentHeight = Double(CommandLine.arguments[4])!
let previous = NSWorkspace.shared.frontmostApplication
NSRunningApplication(processIdentifier: pid)?.activate(options: [])
Thread.sleep(forTimeInterval: 0.5)
defer { if let previous, previous.processIdentifier != pid { previous.activate(options: []) } }
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
send(.leftMouseDown, start)
Thread.sleep(forTimeInterval: 0.15)
send(.leftMouseDragged, CGPoint(x: start.x + 12, y: start.y))
Thread.sleep(forTimeInterval: 0.3)
// Do not press another app. Only the up belonging to this fixture's drag is
// sent beyond its window; the app's watchdog must release the capture.
let outside = CGPoint(x: before.maxX + 12, y: start.y)
send(.leftMouseDragged, outside)
Thread.sleep(forTimeInterval: 0.2)
send(.leftMouseUp, outside)
Thread.sleep(forTimeInterval: 0.4)
print("PASS physical release outside fixture window")
