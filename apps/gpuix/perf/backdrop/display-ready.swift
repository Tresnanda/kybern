import Foundation
import CoreGraphics
var ids=[CGDirectDisplayID](repeating:0,count:16)
var count:UInt32=0
let status=CGGetActiveDisplayList(16,&ids,&count)
let displays=ids.prefix(Int(count)).map {id -> [String:Any] in
 let b=CGDisplayBounds(id)
 let mode=CGDisplayCopyDisplayMode(id)
 let scale=mode.map {Double($0.pixelWidth)/Double(max(1,$0.width))} ?? 0
 return ["id":id,"builtin":CGDisplayIsBuiltin(id) != 0,"x":b.minX,"y":b.minY,"width":b.width,"height":b.height,"pixelWidth":CGDisplayPixelsWide(id),"pixelHeight":CGDisplayPixelsHigh(id),"backingScale":scale]
}
let ready=status == .success && displays.contains {($0["builtin"] as? Bool) == true && abs(($0["backingScale"] as? Double ?? 0)-2)<0.01}
let record:[String:Any] = ["time":Date().timeIntervalSince1970,"ready":ready,"activeDisplays":displays]
if let data=try? JSONSerialization.data(withJSONObject:record,options:[.sortedKeys]),let text=String(data:data,encoding:.utf8){print(text)}
exit(ready ? 0 : 75)
