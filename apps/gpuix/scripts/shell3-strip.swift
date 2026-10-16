import AppKit
let args=CommandLine.arguments
let paths=Array(args.dropFirst(2)),cellW:CGFloat=256,labelH:CGFloat=24
let images=paths.compactMap{NSImage(contentsOfFile:$0)}
precondition(images.count == paths.count && !images.isEmpty)
let cellH=cellW * images[0].size.height/images[0].size.width
let canvas=NSImage(size:NSSize(width:cellW*CGFloat(images.count),height:cellH+labelH))
canvas.lockFocus()
NSColor.windowBackgroundColor.setFill();NSRect(origin:.zero,size:canvas.size).fill()
for (i,img) in images.enumerated(){let x=CGFloat(i)*cellW;img.draw(in:NSRect(x:x,y:0,width:cellW,height:cellH));let label=URL(fileURLWithPath:paths[i]).deletingPathExtension().lastPathComponent;label.draw(at:NSPoint(x:x+8,y:cellH+5),withAttributes:[.font:NSFont.monospacedSystemFont(ofSize:11,weight:.medium),.foregroundColor:NSColor.labelColor])}
canvas.unlockFocus()
let rep=NSBitmapImageRep(data:canvas.tiffRepresentation!)!
try rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:args[1]))
