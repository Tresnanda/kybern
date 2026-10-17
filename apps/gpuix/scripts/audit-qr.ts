// Audit-only relocation of src/environments/verify-qr.ts; assertions and UI steps unchanged.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { pairingQrMatrix, pairingQrSvg } from '../src/environments/qr.ts'
const cliEnv={...process.env};delete cliEnv.KYBERN_URL;delete cliEnv.KYBERN_TOKEN
const output = execFileSync('/Applications/kybern.app/Contents/MacOS/kybern', ['--data-dir', process.env.KYBERN_DATA_DIR!, 'pair', '--address', 'http://192.0.2.10:4227'], { encoding: 'utf8',env:cliEnv })
const text = output.match(/Invitation: (kybern:\/\/pair\?[^\s]+)/)?.[1]
const rows = output.split('\n').filter((line) => /^[ ▄▀█]{21,}$/.test(line))
if (!text || !rows.length) throw Error('CLI did not render a QR invitation')
const size = rows[0]!.length - 8
const full = rows.flatMap((line) => [[...line].map((c) => c === '█' || c === '▀'), [...line].map((c) => c === '█' || c === '▄')])
const desktop = full.slice(4, size + 4).map((line) => line.slice(4, size + 4))
const native = pairingQrMatrix(text)
const mismatches = native.length === size ? native.reduce((total, row, y) => total + row.filter((value, x) => value !== desktop[y]?.[x]).length, 0) : null
const result = { desktopSize: size, nativeSize: native.length, mismatches, exact: mismatches === 0 }
// Different valid QR masks can encode the same payload; Vision decode below is the functional assertion.
// Store the invitation only as a scratch verification artifact; no credentials.
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted/qr-comparison.json', JSON.stringify(result, null, 2))
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted/qr-verification.svg', pairingQrSvg(text))
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted/qr-expected.txt', text)
console.log(result)
execFileSync('qlmanage', ['-t', '-s', '768', '-o', '/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted', '/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted/qr-verification.svg'], { stdio: 'pipe' })
console.log(execFileSync('swift', ['-module-cache-path', '/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted/swift-cache', 'scripts/decode-qr.swift', '/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted/qr-verification.svg.png', '/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted/qr-expected.txt'], { encoding: 'utf8' }).trim())
