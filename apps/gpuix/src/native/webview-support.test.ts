// The web view capability: decided from the platform, `KYBERN_GPUIX_NO_WEBVIEW` and (Windows) the host's runtime probe,
// passed in so no global is touched.
import { expect, test } from 'bun:test'
import { linuxSandboxProbe, noteWebViewUnavailable, WEB_VIEW_MISSING, webViewMissingText, webViewSupport, type LinuxSandboxSystem } from './webview-support.ts'
import { fileURLToPath } from 'node:url'

test('macOS always has an embedded web view, Windows when its host finds a WebView2 Runtime', () => {
  expect(webViewSupport('darwin', {})).toEqual({ available: true, reason: null })
  expect(webViewSupport('win32', {}, () => 'ready')).toEqual({ available: true, reason: null })
  expect(webViewSupport('win32', {}, () => 'runtime')).toEqual({ available: false, reason: 'runtime' })
  expect(webViewSupport('win32', {}, () => 'missing')).toEqual({ available: false, reason: 'missing' })
  expect(webViewSupport('win32', {})).toEqual({ available: false, reason: 'platform' })
  expect(webViewSupport('linux', {}, () => 'ready')).toEqual({ available: false, reason: 'platform' })
  expect(webViewSupport('win32', { KYBERN_GPUIX_NO_WEBVIEW: '1' }, () => 'ready')).toEqual({ available: false, reason: 'disabled' })
})
test('Linux has one when the companion exists and its pages can be sandboxed (WP10)', () => {
  expect(webViewSupport('linux', {})).toEqual({ available: false, reason: 'platform' })
  expect(webViewSupport('linux', {}, undefined, () => ({ loaded: false }))).toEqual({ available: false, reason: 'platform' })
  expect(webViewSupport('linux', {}, undefined, () => ({ loaded: true, unavailable: null }))).toEqual({ available: true, reason: null })
  const refused = 'This system does not let Kybern sandbox web pages.'
  expect(webViewSupport('linux', {}, undefined, () => ({ loaded: true, unavailable: refused }))).toEqual({ available: false, reason: 'sandbox', message: refused })
  let probed = false
  expect(webViewSupport('linux', { KYBERN_GPUIX_NO_WEBVIEW: '1' }, undefined, () => { probed = true; return { loaded: true, unavailable: null } }).reason).toBe('disabled')
  expect(probed).toBe(false)
  expect(webViewMissingText('sandbox')).toMatch(/open in your browser/)
  noteWebViewUnavailable('sandbox', refused)
  expect(WEB_VIEW_MISSING).toBe(refused)
  noteWebViewUnavailable('platform')
})
// `linuxProbe` in webview.ts, with the file system and bwrap stood in (`check_sandbox` in webview-linux.c mirrors it).
const LIB = '/opt/kybern/resources/libkybern-webview.so', OWN = '/opt/kybern/resources/wpe/lib/wpe-webkit-2.0/bwrap'
function linuxSystem({ env = {}, files = [LIB, '/usr/bin/xdg-dbus-proxy', '/usr/bin/bwrap'], working = ['/usr/bin/bwrap'] }: { env?: Record<string, string>; files?: string[]; working?: string[] } = {}) {
  const ran: string[] = []
  const system: LinuxSandboxSystem = { env, exists: file => files.includes(file), bwrapWorks: bwrap => { ran.push(bwrap); return working.includes(bwrap) } }
  return { system, ran }
}
const refusal = (probe: ReturnType<typeof linuxSandboxProbe>) => probe.loaded ? probe.unavailable : undefined
test('Linux probe: no companion, or a working system or Kybern bwrap', () => {
  expect(linuxSandboxProbe(LIB, linuxSystem({ files: [] }).system)).toEqual({ loaded: false })
  expect(linuxSandboxProbe(LIB, linuxSystem().system)).toEqual({ loaded: true, unavailable: null })
  const own = linuxSystem({ working: [OWN] })
  expect(linuxSandboxProbe(LIB, own.system)).toEqual({ loaded: true, unavailable: null })
  expect(own.ran).toEqual(['/usr/bin/bwrap', OWN])
  expect(refusal(linuxSandboxProbe(LIB, linuxSystem({ working: [] }).system))).toMatch(/cannot create a user namespace.*browser/)
  expect(refusal(linuxSandboxProbe(LIB, linuxSystem({ files: [LIB, '/usr/bin/xdg-dbus-proxy'], working: [] }).system))).toMatch(/^Install bubblewrap/)
  expect(refusal(linuxSandboxProbe(LIB, linuxSystem({ files: [LIB, '/usr/bin/bwrap'] }).system))).toMatch(/^Install xdg-dbus-proxy/)
})
test('Linux probe: where upstream WebKit would drop the sandbox, pages open in the browser and bwrap is never tried', () => {
  const cases: { env?: Record<string, string>; files?: string[]; expect: RegExp }[] = [
    { env: { SNAP: '/snap/code/1', SNAP_NAME: 'code', SNAP_REVISION: '1' }, expect: /inside a Snap/ },
    { env: { WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1' }, expect: /WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS/ },
    { env: { WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '' }, expect: /WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS/ },
    { files: [LIB, '/usr/bin/xdg-dbus-proxy', '/usr/bin/bwrap', '/.flatpak-info'], expect: /Flatpak/ },
  ]
  for (const c of cases) {
    const { system, ran } = linuxSystem({ env: c.env, files: c.files })
    const probe = linuxSandboxProbe(LIB, system)
    expect(probe.loaded).toBe(true)
    expect(probe.loaded && probe.unavailable).toMatch(c.expect)
    expect(ran).toEqual([])
    expect(webViewSupport('linux', {}, undefined, () => probe).reason).toBe('sandbox')
  }
  // Only all three Snap variables mean a Snap (WebKit's own test); `…DANGEROUS=0` is WebKit's "off"; the old test switch is gone.
  for (const env of <Record<string, string>[]>[{ SNAP: '/x' }, { SNAP: '/x', SNAP_NAME: 'n' }, { WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '0' }, { KYBERN_WEBVIEW_ALLOW_UNSANDBOXED_FOR_TESTS: '1' }])
    expect(linuxSandboxProbe(LIB, linuxSystem({ env }).system)).toEqual({ loaded: true, unavailable: null })
  expect(refusal(linuxSandboxProbe(LIB, linuxSystem({ env: { KYBERN_WEBVIEW_ALLOW_UNSANDBOXED_FOR_TESTS: '1' }, working: [] }).system))).toMatch(/browser/)
})

test('the fallback copy says what to do for each reason', () => {
  expect(webViewMissingText('runtime')).toMatch(/^Install the Microsoft Edge WebView2 Runtime .*then reopen Kybern/)
  expect(webViewMissingText('missing')).toMatch(/Reinstall Kybern/)
  expect(webViewMissingText('platform')).toBe("Kybern can't embed web pages on this platform yet.")
  noteWebViewUnavailable('runtime')
  expect(WEB_VIEW_MISSING).toBe(webViewMissingText('runtime'))
  noteWebViewUnavailable('platform')
})
test('KYBERN_GPUIX_NO_WEBVIEW turns the capability off anywhere and other values do not', () => {
  for (const value of ['1', 'true', 'YES', 'on']) expect(webViewSupport('darwin', { KYBERN_GPUIX_NO_WEBVIEW: value })).toEqual({ available: false, reason: 'disabled' })
  for (const value of ['', '0', 'false', 'no']) expect(webViewSupport('darwin', { KYBERN_GPUIX_NO_WEBVIEW: value }).available).toBe(true)
})

// `webHost` reads the switch once at load, so it is checked in a child that starts with it set.
test('with the web view off every webHost call is a safe no-op and nothing is loaded', async () => {
  const script = `
    const { webHost } = await import(${JSON.stringify(fileURLToPath(new URL('./webview.ts', import.meta.url)))})
    const rect = { x: 0, y: 0, width: 10, height: 10 }
    const seen = []
    webHost.subscribe(event => seen.push(event))
    const logical = { width: 10, height: 10, scale: 1, left: 0, top: 0 }
    if (webHost.available !== false || webHost.unavailableReason !== 'disabled') throw Error('capability should be off')
    webHost.createDocument('doc', '<p>x</p>'); webHost.create('a', 'https://example.com/', 'visual')
    webHost.place('a', rect, rect, logical); webHost.hide('a'); webHost.present('a', { opacity: 1 }); webHost.post('a', '1'); webHost.send('a', { kind: 'x' })
    webHost.snapshot('a', '/tmp/x.png', 1); webHost.theme('a', {}); webHost.navigate('a', 'https://example.com/'); webHost.action('a', 'reload'); webHost.probe('a')
    webHost.releaseFocus(); webHost.focus('a'); webHost.occlusion(1, rect); webHost.occlusion(1, null); webHost.capturePointer()(); webHost.destroy('a')
    if (webHost.documents().length) throw Error('no document can exist')
    for (const call of [() => webHost.frame('a', '1'), () => webHost.snapshotRect('a', rect, '/tmp/x.png')]) {
      const failure = await call().then(() => null, error => error)
      if (!failure || !/no embedded web view/.test(failure.message)) throw Error('requests should reject with an explanation')
    }
    if (seen.length) throw Error('no event can arrive')
  `
  const child = Bun.spawn(['bun', '-e', script], { env: { ...process.env, KYBERN_GPUIX_NO_WEBVIEW: '1' }, stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(child.stderr).text()
  expect(await child.exited, output).toBe(0)
})
test('Windows and Linux preview pages run without allow-modals (no print UI or page dialogs); macOS keeps its sandbox', async () => {
  const { webDocument } = await import('./webview.ts')
  const sandbox = (html: string) => /sandbox="([^"]*)"/.exec(html)?.[1]
  expect(sandbox(webDocument('http://localhost:3000/', 'server', 'darwin'))).toBe('allow-scripts allow-same-origin allow-forms allow-modals allow-downloads')
  expect(sandbox(webDocument('http://127.0.0.1:4199/f', 'file', 'darwin'))).toBe('allow-scripts allow-forms allow-modals')
  expect(sandbox(webDocument('http://localhost:3000/', 'server', 'win32'))).toBe('allow-scripts allow-same-origin allow-forms allow-downloads')
  expect(sandbox(webDocument('http://127.0.0.1:4199/f', 'file', 'win32'))).toBe('allow-scripts allow-forms')
  expect(sandbox(webDocument('http://127.0.0.1:4199/v', 'visual', 'win32'))).toBe('allow-scripts')
  expect(sandbox(webDocument('http://localhost:3000/', 'server', 'linux'))).toBe('allow-scripts allow-same-origin allow-forms allow-downloads')
  expect(sandbox(webDocument('http://127.0.0.1:4199/f', 'file', 'linux'))).toBe('allow-scripts allow-forms')
})
