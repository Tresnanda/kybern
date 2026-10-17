// swift kit9-px.swift <png> <x> <y>   prints r g b (0-1) of the pixel at image coordinates
import AppKit
let a = CommandLine.arguments
let r = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: a[1])))!
let c = r.colorAt(x: Int(a[2])!, y: Int(a[3])!)!.usingColorSpace(.sRGB)!
print(String(format: "%.3f %.3f %.3f", c.redComponent, c.greenComponent, c.blueComponent))
