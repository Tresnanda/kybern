import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { notifications } from '../src/native/notifications.ts'
const dir = path.join(import.meta.dir, 'build/notification-check')
mkdirSync(dir, { recursive: true })
const run = (args: string[]) => Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
try {
  const source = path.join(import.meta.dir, 'notification-probe.m')
  const flags = ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'UserNotifications']
  for (const [extra, output] of [[['-dynamiclib'], 'probe.dylib'], [[], 'probe']] as const) {
    const result = run(['clang', ...flags, ...extra, source, '-o', path.join(dir, output)])
    assert.equal(result.exitCode, 0, result.stderr.toString())
  }
  for (const legacy of [false, true]) {
    const result = run(['bun', '-e', `import { dlopen, FFIType } from 'bun:ffi'; const lib = dlopen(${JSON.stringify(path.join(dir, 'probe.dylib'))}, { probe: {args:[FFIType.bool],returns:FFIType.i32} }); lib.symbols.probe(${legacy})`])
    const output = result.stdout.toString() + result.stderr.toString()
    if (legacy) assert.match(output, /legacy center=nil/)
    else { assert.notEqual(result.exitCode, 0); assert.match(output, /bundle=\(none\)/); assert.match(output, /A C\+\+ exception occurred|bundleProxyForCurrentProcess is nil/) }
    console.log(`ok Bun ${legacy ? 'legacy center is nil' : 'modern center aborts without bundle identity'}`)
  }
  const standalone = run([path.join(dir, 'probe')])
  assert.notEqual(standalone.exitCode, 0)
  assert.match(standalone.stderr.toString(), /bundleProxyForCurrentProcess is nil/)
  const bundle = path.join(dir, 'Probe.app/Contents')
  mkdirSync(path.join(bundle, 'MacOS'), { recursive: true })
  copyFileSync(path.join(dir, 'probe'), path.join(bundle, 'MacOS/probe'))
  writeFileSync(path.join(bundle, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.kybern.gpuix.notification-probe</string><key>CFBundleExecutable</key><string>probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
  const result = run([path.join(bundle, 'MacOS/probe')])
  assert.equal(result.exitCode, 0, result.stderr.toString())
  assert.match(result.stdout.toString(), /modern center=available/)
  assert.equal(await notifications.status(), 'unsupported')
  // The merged packaged-host adapter reports unsupported sends as false.
  assert.equal(await notifications.post({ id: 'fixture', title: 'fixture', body: 'fixture' }), false)
  assert.match(notifications.reason ?? '', /packaged Kybern GPUIX/)
  console.log('ok bundled center available; no authorization request or notification posted')
} finally { rmSync(dir, { recursive: true, force: true }) }
