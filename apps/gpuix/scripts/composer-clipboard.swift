// Holds the original system pasteboard in memory and restores it only if nobody else changed it.
import AppKit
import Foundation
let board = NSPasteboard.general
let original = (board.pasteboardItems ?? []).map { source -> NSPasteboardItem in
    let item = NSPasteboardItem()
    for type in source.types { if let bytes = source.data(forType: type) { item.setData(bytes, forType: type) } }
    return item
}
var written = board.changeCount
var changed = false
func restore() {
    guard changed && board.changeCount == written else { return }
    board.clearContents()
    board.writeObjects(original)
    changed = false
}
defer { restore() }
print("READY"); fflush(stdout)
while let line = readLine(), let bytes = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: bytes) as? [String:String] {
    if command["kind"] == "restore" { restore(); print("RESTORED"); fflush(stdout); break }
    // Refuse to overwrite a user's new clipboard while the test is running.
    guard board.changeCount == written else { print("CHANGED"); fflush(stdout); break }
    board.clearContents()
    if command["kind"] == "image", let path = command["path"], let data = try? Data(contentsOf: URL(fileURLWithPath: path)) {
        board.setData(data, forType: .png)
    } else if command["kind"] == "files", let path = command["path"] {
        board.writeObjects([URL(fileURLWithPath:path) as NSURL])
    } else if command["kind"] == "text" { board.setString("Clipboard text fixture", forType:.string) }
    written = board.changeCount; changed = true
    print("SET"); fflush(stdout)
}
