// swift kit9-strip.swift <out.png> <cellWidth> <label>=<a.png>,<b.png>,... [<label>=...]
// Stacks one labelled row of frames per argument (e.g. desktop over GPUIX), each cell scaled to <cellWidth> px wide.
import AppKit
let args = CommandLine.arguments
let out = args[1], cellW = CGFloat(Double(args[2])!)
struct Row { let label: String; let files: [String] }
let rows = args.dropFirst(3).map { a -> Row in
  let p = a.split(separator: "=", maxSplits: 1).map(String.init)
  return Row(label: p[0], files: p[1].split(separator: ",").map(String.init))
}
let labelH: CGFloat = 20
var layout: [[(NSImage, String)]] = []
var height: CGFloat = 0, width: CGFloat = 0
for r in rows {
  let imgs = r.files.compactMap { f in NSImage(contentsOfFile: f).map { ($0, URL(fileURLWithPath: f).deletingPathExtension().lastPathComponent) } }
  precondition(imgs.count == r.files.count, "missing image in row \(r.label)")
  layout.append(imgs)
  let h = imgs.map { cellW * $0.0.size.height / $0.0.size.width }.max() ?? 0
  height += h + labelH
  width = max(width, cellW * CGFloat(imgs.count))
}
let canvas = NSImage(size: NSSize(width: width, height: height))
canvas.lockFocus()
NSColor.gray.setFill(); NSRect(origin: .zero, size: canvas.size).fill()
var y = height
for (ri, imgs) in layout.enumerated() {
  let h = imgs.map { cellW * $0.0.size.height / $0.0.size.width }.max() ?? 0
  y -= labelH
  (rows[ri].label as NSString).draw(at: NSPoint(x: 6, y: y + 3), withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.white])
  y -= h
  for (i, (img, name)) in imgs.enumerated() {
    let x = CGFloat(i) * cellW
    img.draw(in: NSRect(x: x, y: y, width: cellW, height: cellW * img.size.height / img.size.width))
    (name as NSString).draw(at: NSPoint(x: x + 4, y: y + 3), withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 10, weight: .medium), .foregroundColor: NSColor.systemOrange])
  }
}
canvas.unlockFocus()
let rep = NSBitmapImageRep(data: canvas.tiffRepresentation!)!
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
