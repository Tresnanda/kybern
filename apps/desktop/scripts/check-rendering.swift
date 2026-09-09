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
  config.websiteDataStore = .nonPersistent()
  config.userContentController.add(self, name: "bench")
  config.setURLSchemeHandler(Assets(), forURLScheme: "tauri")
  web = WKWebView(frame: NSRect(x: 0, y: 0, width: Double(ProcessInfo.processInfo.environment["KYBERN_PERF_WIDTH"] ?? "1100") ?? 1100, height: Double(ProcessInfo.processInfo.environment["KYBERN_PERF_HEIGHT"] ?? "720") ?? 720), configuration: config)
  window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
  window.title = "Kybern rendering checks"
  window.contentView = web
  window.orderFront(nil)
  let fixture = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "rendering"
  let history = Int(ProcessInfo.processInfo.environment["KYBERN_PERF_HISTORY"] ?? "400") ?? 400
  web.load(URLRequest(url: URL(string: "tauri://localhost/perf/\(fixture).html?history=\(history)")!))
 }
 func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
  print(message.body)
  let json = (message.body as? String)?.data(using: .utf8)
  let result = json.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  if result?["stage"] != nil {
   if result?["memory"] as? Bool == true, web.responds(to: NSSelectorFromString("_webProcessIdentifier")), let pid = web.value(forKey: "_webProcessIdentifier") as? Int {
    let process = Process(); let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/vmmap")
    process.arguments = ["-summary", String(pid)]; process.standardOutput = pipe; process.standardError = pipe
    try! process.run()
    let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    process.waitUntilExit()
    let footprint = output.components(separatedBy: "\n").filter { $0.hasPrefix("Physical footprint:") }.first ?? "unavailable"
    let record: [String: Any] = ["sample": result!["stage"]!, "footprint": footprint, "pid": pid]
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
