// Displayed animation cadence of one window region, as WindowServer composites it.
//
//   swift perf/motion-fps/cadence.swift <pid> <seconds> <x> <y> <w> <h> [png-dir]
//
// App submissions miss motion that Core Animation runs (compositor loops), and count submissions that
// change nothing. ScreenCaptureKit streams the window at up to 60 Hz; every delivered frame's crop
// (window points, top-left origin) is hashed, and the intervals between *changed* crops are the
// delivered animation frame rate. over25/over50 count gaps of more than 1.5 / 3 display frames. Optional PNGs of the first 24 frames make a strip.
import AppKit
import CoreMedia
import ScreenCaptureKit

let args = CommandLine.arguments
let pid = Int32(args[1])!, seconds = Double(args[2])!
let crop = CGRect(x: Double(args[3])!, y: Double(args[4])!, width: Double(args[5])!, height: Double(args[6])!)
let pngs = args.count > 7 ? URL(fileURLWithPath: args[7]) : nil
if let pngs { try FileManager.default.createDirectory(at: pngs, withIntermediateDirectories: true) }

final class Sink: NSObject, SCStreamOutput {
  var frames = 0, changes: [Double] = [], last: Int?, saved = 0, scale = 2.0
  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, let image = buffer.imageBuffer,
          let info = (CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
          let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
    frames += 1
    CVPixelBufferLockBaseAddress(image, .readOnly); defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
    let base = CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to: UInt8.self), row = CVPixelBufferGetBytesPerRow(image)
    let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
    let x0 = max(0, Int(crop.minX * scale)), y0 = max(0, Int(crop.minY * scale))
    let x1 = min(width, Int(crop.maxX * scale)), y1 = min(height, Int(crop.maxY * scale))
    var hash = 1469598103934665603 as UInt64
    for y in y0..<y1 { for x in (x0 * 4)..<(x1 * 4) { hash = (hash ^ UInt64(base[y * row + x])) &* 1099511628211 } }
    let key = Int(truncatingIfNeeded: hash)
    let t = CMSampleBufferGetPresentationTimeStamp(buffer).seconds * 1000
    if key != last { changes.append(t); last = key
      if let pngs, saved < 24 {
        let ci = CIImage(cvPixelBuffer: image).cropped(to: CGRect(x: x0, y: height - y1, width: x1 - x0, height: y1 - y0))
        let rep = NSBitmapImageRep(ciImage: ci)
        try? rep.representation(using: .png, properties: [:])?.write(to: pngs.appendingPathComponent(String(format: "%02d.png", saved)))
        saved += 1
      }
    }
  }
}

let sink = Sink()
let done = DispatchSemaphore(value: 0)
Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let window = content.windows.filter({ $0.owningApplication?.processID == pid && $0.frame.width > 200 }).max(by: { $0.frame.width < $1.frame.width }) else { print("error: no window"); exit(2) }
    let config = SCStreamConfiguration()
    config.width = Int(window.frame.width * 2); config.height = Int(window.frame.height * 2)
    config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    config.queueDepth = 8; config.showsCursor = false
    let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: nil)
    try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "cadence"))
    try await stream.startCapture()
    try await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
    try await stream.stopCapture()
  } catch { print("error: \(error)"); exit(1) }
  done.signal()
}
done.wait()
let d = zip(sink.changes.dropFirst(), sink.changes).map { $0 - $1 }.sorted()
func p(_ q: Double) -> Double { d.isEmpty ? 0 : d[min(d.count - 1, Int(Double(d.count) * q))] }
let span = (sink.changes.last ?? 0) - (sink.changes.first ?? 0)
print(String(format: "{\"frames\":%d,\"changes\":%d,\"changesPerSecond\":%.2f,\"p50\":%.2f,\"p95\":%.2f,\"p99\":%.2f,\"over25\":%d,\"over50\":%d}",
  sink.frames, sink.changes.count, span > 0 ? Double(sink.changes.count - 1) / span * 1000 : 0, p(0.5), p(0.95), p(0.99), d.filter { $0 > 16.7 * 1.5 }.count, d.filter { $0 > 33.4 * 1.5 }.count))
