// The web view capability: decided from the platform and `KYBERN_GPUIX_NO_WEBVIEW`, passed in so no global is touched.
import { expect, test } from 'bun:test'
import { webViewSupport } from './webview-support.ts'
import { fileURLToPath } from 'node:url'

test('only macOS has an embedded web view, until WP10 adds Windows and Linux', () => {
  expect(webViewSupport('darwin', {})).toEqual({ available: true, reason: null })
  expect(webViewSupport('win32', {})).toEqual({ available: false, reason: 'platform' })
  expect(webViewSupport('linux', {})).toEqual({ available: false, reason: 'platform' })
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
