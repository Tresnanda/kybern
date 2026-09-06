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
  web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 720), configuration: config)
  window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
  window.title = "Kybern rendering checks"
  window.contentView = web
  window.orderFront(nil)
  web.load(URLRequest(url: URL(string: "tauri://localhost/perf/rendering.html")!))
 }
 func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
  print(message.body)
  let json = (message.body as? String)?.data(using: .utf8)
  let result = json.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  exit(result?["pass"] as? Bool == true ? 0 : 1)
 }
}
let bench = Bench()
bench.run()
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("Rendering check timed out"); exit(2) }
app.run()
