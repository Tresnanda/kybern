import CoreGraphics
import Foundation
if let d = CGSessionCopyCurrentDictionary() as? [String: Any] {
 print("locked:", d["CGSSessionScreenIsLocked"] ?? 0, "onConsole:", d["kCGSSessionOnConsoleKey"] ?? 0)
}
print("displayAsleep:", CGDisplayIsAsleep(CGMainDisplayID()))
