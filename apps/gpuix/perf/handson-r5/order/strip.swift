import AppKit
let args=CommandLine.arguments
let cells=Array(args.dropFirst(2))
precondition(!cells.isEmpty && cells.count % 2 == 0)
let images=stride(from:1,to:cells.count,by:2).map{NSImage(contentsOfFile:cells[$0])!}
let width:CGFloat=480,header:CGFloat=32
let height=width*images[0].size.height/images[0].size.width
let canvas=NSImage(size:NSSize(width:width*CGFloat(images.count),height:height+header))
canvas.lockFocus()
if let background=NSImage(contentsOfFile:"/Users/mymac/projects/ade/apps/desktop/public/release-background.png") {
    background.draw(in:NSRect(origin:.zero,size:canvas.size))
} else { NSColor.darkGray.setFill();NSRect(origin:.zero,size:canvas.size).fill() }
for (index,image) in images.enumerated() {
    let x=CGFloat(index)*width
    image.draw(in:NSRect(x:x,y:0,width:width,height:height))
    cells[index*2].draw(at:NSPoint(x:x+10,y:height+8),withAttributes:[.font:NSFont.monospacedSystemFont(ofSize:11,weight:.medium),.foregroundColor:NSColor.white])
}
canvas.unlockFocus()
let pixels=NSBitmapImageRep(data:canvas.tiffRepresentation!)!
try pixels.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:args[1]))
