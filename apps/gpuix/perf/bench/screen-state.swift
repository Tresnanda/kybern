import CoreGraphics
import Foundation
if let d = CGSessionCopyCurrentDictionary() as? [String: Any] {
 print("locked:", d["CGSSessionScreenIsLocked"] ?? "nil", "onConsole:", d["kCGSSessionOnConsoleKey"] ?? "nil")
}
print("displayAsleep:", CGDisplayIsAsleep(CGMainDisplayID()))
