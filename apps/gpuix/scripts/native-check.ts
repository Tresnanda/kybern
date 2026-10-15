import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'native-lab.tsx')], env: { NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await app.getByTestId('button').click()
  await app.getByText('Clicks 1').waitFor()
  const below = await app.getByTestId('below-titlebar').bounds()
  assert.equal(below.y, 46)
  await app.mouse.click({ x: below.x + 10, y: 47 })
  await app.getByText('Clicks 2').waitFor()
  console.log('ok  titlebar controls and pointer clicks at y=47 remain clickable')
  const editor = await app.getByTestId('editor').element()
  await app.getByTestId('editor').click()
  for (const key of ['up', 'down', 'enter', 'tab', 'escape']) {
    await app.call('keyDown', { elementId: editor.id, key, isHeld: true })
    await app.getByText(`${key}:repeat`).waitFor()
    assert.equal(await app.getByTestId('value').textContent(), '"first\\nsecond"')
  }
  assert.equal(await app.getByTestId('submits').textContent(), 'Submitted 0')
  console.log('ok  intercepted native actions are cancelled, including auto-repeat')
  await app.call('keyDown', { elementId: editor.id, key: 'shift-enter' })
  await app.getByText('"first\\nsecond\\n"').waitFor()
  console.log('ok  unprevented key resumes native editing')
  await app.call('keystrokes', { elementId: editor.id, keys: 'shift-enter z' })
  await app.getByText(JSON.stringify('first\nsecond\n\nz')).waitFor().catch(async error => { throw new Error(`${error}; actual ${await app.getByTestId('value').textContent()}`) })
  console.log('ok  typing after an intercepted key preserves order')
  await app.call('keyDown', { elementId: editor.id, key: 'cmd-w' })
  await app.getByText('Close requests 1').waitFor()
  await app.getByTestId('button').click()
  await app.getByText('Clicks 3').waitFor()
  console.log('ok  async close veto keeps window interactive')
  const info = await app.call('initialize', { protocolVersion: 1, client: 'native-close-check' })
  await app.getByTestId('native-close').click()
  await app.getByText('Close requests 2').waitFor()
  await app.getByTestId('reject-close').click()
  await app.getByText('Rejection enabled').waitFor()
  await app.call('keyDown', { elementId: editor.id, key: 'cmd-w' })
  await app.getByText('Close requests 3').waitFor()
  console.log('ok  rejected close promise vetoes')
  await app.getByTestId('allow-close').click()
  await app.getByText('Close allowed').waitFor()
  await app.call('keyDown', { elementId: editor.id, key: 'cmd-w' }).catch(() => {})
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { process.kill(info.pid, 0) } catch { console.log('ok  allowed close exits the lab'); break }
    if (Date.now() + 50 >= deadline) throw new Error('allowed close did not exit')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
} finally { await app.close() }
