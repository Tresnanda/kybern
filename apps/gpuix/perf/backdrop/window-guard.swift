import Foundation
import CoreGraphics
let args = Array(CommandLine.arguments.dropFirst())
let byWindow = args.first == "--window"
let target = Int(args[1])!
let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String:Any]]
let on = Set((CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as! [[String:Any]]).compactMap {$0[kCGWindowNumber as String] as? Int})
var displays = [CGDirectDisplayID](repeating:0,count:16)
var count:UInt32 = 0
CGGetActiveDisplayList(16,&displays,&count)
let builtins = displays.prefix(Int(count)).filter {CGDisplayIsBuiltin($0) != 0}.map {CGDisplayBounds($0)}
let windows = all.filter {w in (w[kCGWindowLayer as String] as? Int) == 0 && (byWindow ? (w[kCGWindowNumber as String] as? Int) == target : (w[kCGWindowOwnerPID as String] as? Int) == target)}
let good = windows.contains {w in
 guard let id=w[kCGWindowNumber as String] as? Int, let b=w[kCGWindowBounds as String] as? [String:Double], let x=b["X"], let y=b["Y"], let width=b["Width"], let height=b["Height"] else {return false}
 let rect=CGRect(x:x,y:y,width:width,height:height)
 return on.contains(id) && rect.width > 0 && rect.height > 0 && builtins.contains {$0.contains(rect)}
}
if !good {fputs("Window is occluded or outside the built-in display; capture/sample discarded\n",stderr)}
exit(good ? 0 : 75)
