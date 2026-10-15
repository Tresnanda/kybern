import Foundation
import ApplicationServices
guard AXIsProcessTrusted() else { print("BLOCKED: this terminal lacks Accessibility permission"); exit(2) }
let pid = pid_t(CommandLine.arguments[1])!
let app = AXUIElementCreateApplication(pid)
func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    AXUIElementCopyAttributeValue(element, name as CFString, &result)
    return result
}
if CommandLine.arguments.last == "close" {
    guard let windows = value(app, kAXWindowsAttribute) as? [AXUIElement], let window = windows.first,
        let button = value(window, kAXCloseButtonAttribute) else { print("FAIL missing close button"); exit(1) }
    let error = AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
    guard error == .success else { print("FAIL close action \(error)"); exit(1) }
    print("ok native close button pressed")
} else {
    var found = false
    func walk(_ e: AXUIElement, _ depth: Int) {
        if depth > 30 { return }
        let description = value(e, kAXDescriptionAttribute) as? String ?? ""
        let role = value(e, kAXRoleAttribute) as? String ?? ""
        let subrole = value(e, kAXSubroleAttribute) as? String ?? ""
        let v = value(e, kAXValueAttribute) as? String ?? ""
        if v.contains("a😀é") { print("FAIL plaintext in accessibility value"); exit(1) }
        if subrole == "AXSecureTextField" { found = true; print("ok secure accessibility role \(role)/\(subrole), \(v.count) displayed characters") }
        if description.contains("a😀é") { print("FAIL plaintext in accessibility description"); exit(1) }
        for child in value(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(child, depth + 1) }
    }
    walk(app, 0)
    if !found { print("FAIL secure accessibility role not found"); exit(1) }
}
