// Pair matching elapsed samples: desktop WebKit above, GPUIX below.
import Foundation
import CoreText
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
let root = "/Users/mymac/projects/ade/previews/gpuix/round7/dock7b"
func load(_ path: String) -> CGImage {
  let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)!
  return CGImageSourceCreateImageAtIndex(source, 0, nil)!
}
for theme in ["dark", "light"] { for reduce in ["normal", "reduced"] { for action in ["expand", "collapse"] {
  let label = "\(theme)-\(reduce)-\(action)"
  let times = [0,16,32,64,96,128,176,224,320,600]
  let width = 192, height = 312, gap = 8
  let ctx = CGContext(data:nil,width:(width+gap)*times.count,height:(height+gap+24)*2,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(CGColor(gray:0.45,alpha:1));ctx.fill(CGRect(x:0,y:0,width:ctx.width,height:ctx.height))
  for (row, engine) in ["webkit", "gpuix"].enumerated() {
    let dir = "\(root)/\(label)-\(engine)"
    let data = try! Data(contentsOf:URL(fileURLWithPath:"\(dir)/bounds.json"))
    let json = try! JSONSerialization.jsonObject(with:data)
    let samples = engine == "webkit" ? (json as! [String:Any])["samples"] as! [[String:Any]] : json as! [[String:Any]]
    let closedSample = action == "expand" ? samples.first! : samples.last!
    let sibling = closedSample["sibling"] as! [String:Any]
    let left = (sibling["x"] as! Double)-6, top = (sibling["y"] as! Double)-116
    for (column,time) in times.enumerated() {
      let img = load(String(format:"%@/%03d.png",dir,time)), scale = Double(load(String(format:"%@/%03d.png",dir,time)).width)/1280
      let crop = img.cropping(to:CGRect(x:left*scale,y:top*scale,width:240*scale,height:390*scale))!
      ctx.draw(crop,in:CGRect(x:column*(width+gap),y:(1-row)*(height+gap+24),width:width,height:height))
    }
  }
  for (row, label) in ["Desktop frontend in WebKit · reference", "GPUIX · native SVG rotation + physical springs"].enumerated() {
    let text = NSAttributedString(string: "\(label) · \(theme) / \(reduce) / \(action)", attributes: [NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, 14, nil), NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1)])
    ctx.textPosition = CGPoint(x: 8, y: (1-row)*(height+gap+24)+height+8)
    CTLineDraw(CTLineCreateWithAttributedString(text), ctx)
  }
  let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath:"\(root)/\(label)-strip.png") as CFURL,UTType.png.identifier as CFString,1,nil)!
  CGImageDestinationAddImage(dest,ctx.makeImage()!,nil);CGImageDestinationFinalize(dest)
  print(label,"paired strip")
}}}
