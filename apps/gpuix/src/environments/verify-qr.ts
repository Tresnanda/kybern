import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { pairingQrMatrix, pairingQrSvg } from './qr.ts'
const output = execFileSync('/Applications/kybern.app/Contents/MacOS/kybern', ['--data-dir', '/Users/mymac/projects/ade-gpuix-scratch/environments-second', 'pair', '--address', 'http://192.0.2.10:4227'], { encoding: 'utf8' })
const text = output.match(/Invitation: (kybern:\/\/pair\?[^\s]+)/)?.[1]
const rows = output.split('\n').filter((line) => /^[ ▄▀█]{21,}$/.test(line))
if (!text || !rows.length) throw Error('CLI did not render a QR invitation')
const size = rows[0]!.length - 8
const full = rows.flatMap((line) => [[...line].map((c) => c === '█' || c === '▀'), [...line].map((c) => c === '█' || c === '▄')])
const desktop = full.slice(4, size + 4).map((line) => line.slice(4, size + 4))
const native = pairingQrMatrix(text)
const mismatches = native.length === size ? native.reduce((total, row, y) => total + row.filter((value, x) => value !== desktop[y]?.[x]).length, 0) : null
const result = { desktopSize: size, nativeSize: native.length, mismatches, exact: mismatches === 0 }
// Store the invitation only as a scratch verification artifact; no credentials.
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/environments/qr-comparison.json', JSON.stringify(result, null, 2))
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/environments/qr-verification.svg', pairingQrSvg(text))
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/environments/qr-expected.txt', text)
console.log(result)
execFileSync('qlmanage', ['-t', '-s', '768', '-o', '/Users/mymac/projects/ade/previews/gpuix/environments', '/Users/mymac/projects/ade/previews/gpuix/environments/qr-verification.svg'], { stdio: 'pipe' })
console.log(execFileSync('swift', ['-module-cache-path', '/Users/mymac/projects/ade-gpuix-scratch/qr-swift-cache', 'scripts/decode-qr.swift', '/Users/mymac/projects/ade/previews/gpuix/environments/qr-verification.svg.png', '/Users/mymac/projects/ade/previews/gpuix/environments/qr-expected.txt'], { encoding: 'utf8' }).trim())
