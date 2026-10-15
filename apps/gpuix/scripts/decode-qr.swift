// Test-only system Vision decoder. Never imported or launched by the app.
import Foundation
import Vision

let args = CommandLine.arguments
if args.count != 3 {
    fputs("Usage: swift decode-qr.swift image.png expected-payload.txt\n", stderr)
    exit(2)
}
let expected = try String(contentsOfFile: args[2], encoding: .utf8)
let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
let handler = VNImageRequestHandler(url: URL(fileURLWithPath: args[1]), options: [:])
try handler.perform([request])
guard request.results?.contains(where: { $0.payloadStringValue == expected }) == true else {
    fputs("QR payload did not match the invitation\n", stderr)
    exit(1)
}
print("QR decodes to the exact invitation")
