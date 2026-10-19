import Foundation
import CoreGraphics
import Darwin
let args = Array(CommandLine.arguments.dropFirst())
let byWindow = args.first == "--window"
let target = Int(args[1])!
let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String:Any]]
let on = Set((CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as! [[String:Any]]).compactMap {$0[kCGWindowNumber as String] as? Int})
var displays = [CGDirectDisplayID](repeating:0,count:16)
var count:UInt32 = 0
CGGetActiveDisplayList(16,&displays,&count)
let builtins = displays.prefix(Int(count)).filter {id in
 guard CGDisplayIsBuiltin(id) != 0, let mode=CGDisplayCopyDisplayMode(id) else {return false}
 return abs(Double(mode.pixelWidth)/Double(max(1,mode.width))-2)<0.01
}.map {CGDisplayBounds($0)}
let candidates = all.filter {w in byWindow ? (w[kCGWindowNumber as String] as? Int) == target : (w[kCGWindowOwnerPID as String] as? Int) == target}
func area(_ w:[String:Any]) -> Double {
 let b=w[kCGWindowBounds as String] as? [String:Double] ?? [:]
 return (b["Width"] ?? 0)*(b["Height"] ?? 0)
}
// Native automation screenshots target the application content window. Ignore
// smaller helper/tooltip windows when identifying it by process rather than id.
let windows = byWindow ? candidates : Array(candidates.sorted {area($0)>area($1)}.prefix(1))
let good = windows.contains {w in
 guard let id=w[kCGWindowNumber as String] as? Int, let b=w[kCGWindowBounds as String] as? [String:Double], let x=b["X"], let y=b["Y"], let width=b["Width"], let height=b["Height"] else {return false}
 let rect=CGRect(x:x,y:y,width:width,height:height)
 return on.contains(id) && rect.width > 0 && rect.height > 0 && builtins.contains {$0.contains(rect)}
}
do {
 let path=ProcessInfo.processInfo.environment["KYBERN_WINDOW_GUARD_LOG"] ?? "/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/window-guards.jsonl"
 let rows=windows.map {w -> [String:Any] in
  let id=w[kCGWindowNumber as String] as? Int ?? -1
  return ["window":id,"layer":w[kCGWindowLayer as String] ?? -1,"onscreen":on.contains(id),"bounds":w[kCGWindowBounds as String] ?? [String:Double]()]
 }
 let record:[String:Any] = ["time":Date().timeIntervalSince1970,"selector":args[0],"target":target,"accepted":good,"windows":rows,"builtInBounds":builtins.map {["x":$0.minX,"y":$0.minY,"width":$0.width,"height":$0.height]}]
 if var data=try? JSONSerialization.data(withJSONObject:record,options:[.sortedKeys]) {
  data.append(10)
  let fd=open(path,O_WRONLY|O_CREAT|O_APPEND,0o600)
  if fd >= 0 {data.withUnsafeBytes {(bytes:UnsafeRawBufferPointer) in _ = Darwin.write(fd,bytes.baseAddress!,bytes.count)};close(fd)}
 }
}
if !good {fputs("Window is occluded or outside the 2x built-in display; capture/sample discarded\n",stderr)}
exit(good ? 0 : 75)
