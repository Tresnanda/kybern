import CoreGraphics
import Foundation
let pid=Int32(CommandLine.arguments[1])!
let windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
for w in windows where (w[kCGWindowOwnerPID as String] as? Int32)==pid && (w[kCGWindowLayer as String] as? Int)==0 {
 print(w[kCGWindowNumber as String] as! Int);exit(0)
}
exit(1)
