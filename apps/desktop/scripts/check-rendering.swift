// Run via check-rendering.mjs: production components, Tauri asset scheme and CSP.
import AppKit
import WebKit
import UniformTypeIdentifiers
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
final class Assets: NSObject, WKURLSchemeHandler {
 let root = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
 let policy = String(decoding: try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])), as: UTF8.self)
 func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
  guard let url = task.request.url else { return }
  let file = root.appendingPathComponent(url.path).standardizedFileURL
  guard file.path.hasPrefix(root.path + "/") else { task.didFailWithError(NSError(domain: "Invalid asset", code: 1)); return }
  do {
   var data = try Data(contentsOf: file)
   if file.pathExtension == "html" {

    let html = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "<head>", with: "<head><meta http-equiv=\"Content-Security-Policy\" content=\"" + policy + "\">")
    data = Data(html.utf8)
   }
   let mime = file.pathExtension == "js" ? "text/javascript" : UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
   let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Content-Security-Policy": policy])!
   task.didReceive(response)
   task.didReceive(data)
   task.didFinish()
  } catch { task.didFailWithError(error) }
 }
 func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
final class Bench: NSObject, WKScriptMessageHandler {
 var window: NSWindow!
 var web: WKWebView!
 func run() {
  let config = WKWebViewConfiguration()
  // Opt-in for unattended active-workload comparisons. Keep the production
  // scheduling policy for visibility/idle tests and for the application itself.
  if ProcessInfo.processInfo.environment["KYBERN_PERF_KEEP_ACTIVE"] == "1" {
   if #available(macOS 14.0, *) { config.preferences.inactiveSchedulingPolicy = .none }
  }
  config.websiteDataStore = .nonPersistent()
  config.userContentController.add(self, name: "bench")
  config.setURLSchemeHandler(Assets(), forURLScheme: "tauri")
  if ProcessInfo.processInfo.environment["KYBERN_PERF_DEBUG_LAYERS"] == "1" {
   // Diagnostic only: WebKit's compositing borders and tiled-layer indicator overlay.
   for key in ["compositingBordersVisible", "compositingRepaintCountersVisible", "tiledScrollingIndicatorVisible"] { config.preferences.setValue(true, forKey: key) }
  }
  web = WKWebView(frame: NSRect(x: 0, y: 0, width: Double(ProcessInfo.processInfo.environment["KYBERN_PERF_WIDTH"] ?? "1100") ?? 1100, height: Double(ProcessInfo.processInfo.environment["KYBERN_PERF_HEIGHT"] ?? "720") ?? 720), configuration: config)
  window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
  window.title = "Kybern rendering checks"
  if ProcessInfo.processInfo.environment["KYBERN_PERF_DEBUG_LAYERS"] == "1" || ProcessInfo.processInfo.environment["KYBERN_PERF_HOLD"] == "1" { print("Debug window id: \(window.windowNumber)"); fflush(stdout) }
  window.contentView = web
  window.orderFront(nil)
  let fixture = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "rendering"
  let history = Int(ProcessInfo.processInfo.environment["KYBERN_PERF_HISTORY"] ?? "400") ?? 400
  var query = "?history=\(history)"
  if ProcessInfo.processInfo.environment["KYBERN_PERF_NATIVE_IMAGE"] == "1" { query += "&native-image=1" }
  web.load(URLRequest(url: URL(string: "tauri://localhost/perf/\(fixture).html\(query)")!))
 }
 func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
  print(message.body)
  fflush(stdout)
  let json = (message.body as? String)?.data(using: .utf8)
  let result = json.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  if result?["stage"] != nil {
   if result?["nativeClipboardBytes"] as? Bool == true, let encoded = result?["data"] as? [Int] {
    // Verify the production native fallback on the real macOS pasteboard.
    let board = NSPasteboard.general
    let saved = (board.pasteboardItems ?? []).map { item in
     let copy = NSPasteboardItem()
     for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
     return copy
    }
    let data = Data(encoded.compactMap { value in value >= 0 && value <= 255 ? UInt8(value) : nil })
    let pngType = NSPasteboard.PasteboardType("public.png")
    board.clearContents()
    let copied = board.setData(data, forType: pngType)
    let signature = data.count >= 8 && Array(data.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10]
    board.clearContents()
    if !saved.isEmpty { board.writeObjects(saved) }
    web.evaluateJavaScript("window.__nativeImageContinue(\(copied && signature ? "true" : "false"))")
    return
   }
   if result?["copySelection"] as? Bool == true, let expected = result?["expected"] as? String {
    // Exercise WebKit's native Copy action, preserving the user's pasteboard.
    let board = NSPasteboard.general
    let saved = (board.pasteboardItems ?? []).map { item in
     let copy = NSPasteboardItem()
     for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
     return copy
    }
    window.makeFirstResponder(web)
    let before = board.changeCount
    let sent = NSApp.sendAction(NSSelectorFromString("copy:"), to: web, from: nil)
    // Copy crosses the WebContent process boundary; wait for its reply before
    // reading or restoring the pasteboard, rather than racing the IPC.
    let deadline = Date().addingTimeInterval(3)
    func finishCopy() {
     if sent && board.changeCount == before && Date() < deadline {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.025, execute: finishCopy)
      return
     }
     let copied = sent && board.changeCount != before && board.string(forType: .string) == expected
     // Do not overwrite a concurrent copy made by the user in another app.
     if copied {
      board.clearContents()
      if !saved.isEmpty { board.writeObjects(saved) }
     }
     web.evaluateJavaScript("window.__clipboardContinue(\(copied ? "true" : "false"))")
    }
    finishCopy()
    return
   }
   if result?["process"] as? Bool == true, web.responds(to: NSSelectorFromString("_webProcessIdentifier")), let pid = web.value(forKey: "_webProcessIdentifier") as? Int {
    print("{\"webPid\":\(pid)}")
   }
   if ProcessInfo.processInfo.environment["KYBERN_PERF_DEBUG_LAYERS"] == "1", result?["memory"] as? Bool == true {
    // Diagnostic only: dump whichever private tree descriptions this WebKit exposes.
    for selector in ["_scrollingTreeAsText", "_layerTreeAsText", "_internalLayerTreeAsText", "_compositingLayerTreeAsText", "_renderTreeAsText"] {
     if web.responds(to: NSSelectorFromString(selector)), let text = web.value(forKey: selector) as? String { print("=== \(selector)\n\(text)") } else { print("=== \(selector): unavailable") }
    }
   }
   if result?["memory"] as? Bool == true, web.responds(to: NSSelectorFromString("_webProcessIdentifier")), let pid = web.value(forKey: "_webProcessIdentifier") as? Int {
    let process = Process(); let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/vmmap")
    process.arguments = ["-summary", String(pid)]; process.standardOutput = pipe; process.standardError = pipe
    try! process.run()
    let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    process.waitUntilExit()
    if let directory = ProcessInfo.processInfo.environment["KYBERN_PERF_MEMORY_DIR"] {
     let folder = URL(fileURLWithPath: directory, isDirectory: true)
     try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
     let stage = (result?["stage"] as? String ?? "sample").replacingOccurrences(of: "/", with: "-")
     try? output.write(to: folder.appendingPathComponent(stage + ".txt"), atomically: true, encoding: .utf8)
    }
    let footprint = output.components(separatedBy: "\n").filter { $0.hasPrefix("Physical footprint:") }.first ?? "unavailable"
    let peak = output.components(separatedBy: "\n").filter { $0.hasPrefix("Physical footprint (peak):") }.first ?? "unavailable"
    let record: [String: Any] = ["sample": result!["stage"]!, "footprint": footprint, "peak": peak, "pid": pid]
    print(String(decoding: try! JSONSerialization.data(withJSONObject: record), as: UTF8.self))
    web.evaluateJavaScript("window.__memoryContinue()")
   }
   fflush(stdout); return
  }
  if ProcessInfo.processInfo.environment["KYBERN_PERF_HOLD"] == "1" {
   print("Preview window id: \(window.windowNumber), pid: \(ProcessInfo.processInfo.processIdentifier)")
   fflush(stdout)
   return
  }
  let status: Int32 = result?["pass"] as? Bool == true ? 0 : 1
  if CommandLine.arguments.count > 4 {
   web.takeSnapshot(with: nil) { image, error in
    if let image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) {
     try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[4]))
    } else { print("Snapshot failed: \(String(describing: error))") }
    exit(status)
   }
  } else { exit(status) }
 }
}
let bench = Bench()
bench.run()
DispatchQueue.main.asyncAfter(deadline: .now() + (ProcessInfo.processInfo.environment["KYBERN_PERF_HOLD"] == "1" ? 180 : 120)) { print("Rendering check timed out"); exit(2) }
app.run()
