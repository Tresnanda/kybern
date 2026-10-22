import '../src/native/local-build.ts'
import { launchFixture } from '../src/requests/harness.ts'
import path from 'node:path'
import assert from 'node:assert/strict'

// GPUIX 0.11 moves focus on Tab by itself. A handler that consumes Tab must stop the default
// (`preventDefault`), or focus moves twice (Settings and the image preview used to move it by hand).
const f = await launchFixture(path.join(import.meta.dir, 'focus-lab.tsx'), { GPUIX_BACKGROUND: '1' }), a = f.app
const focus = async () => { await a.clock.fastForward(64); await Bun.sleep(80); return a.getByTestId('focus').textContent() }
const press = async (keys: string) => { await a.call('keystrokes', { keys }); return focus() }
try {
  await a.getByTestId('ready').waitFor()
  await a.call('focus', { elementId: (await a.getByTestId('stop-a').element()).id })
  assert.equal(await focus(), 'a')
  assert.equal(await press('tab'), 'b', 'one Tab is one move')
  assert.equal(await press('tab'), 'consume')
  assert.equal(await press('tab'), 'consume', 'a handler that consumes Tab keeps focus')
  await a.call('focus', { elementId: (await a.getByTestId('stop-c').element()).id })
  assert.equal(await focus(), 'c')
  assert.equal(await press('shift-tab'), 'consume', 'Shift+Tab goes back exactly one stop')
  assert.equal(await press('shift-tab'), 'consume', 'and the consumed Shift+Tab stays put')
  await a.call('focus', { elementId: (await a.getByTestId('stop-b').element()).id })
  assert.equal(await press('shift-tab'), 'a', 'Shift+Tab from b is one move back')
  console.log('ok  Tab and Shift+Tab move focus one stop; a consumed Tab stays put')

  await a.call('focus', { elementId: (await a.getByTestId('open').element()).id })
  await a.getByTestId('open').click()
  await a.getByTestId('viewer').waitFor({ timeoutMs: 5000 })
  await a.clock.fastForward(600)
  const before = await focus()
  for (let i = 0; i < 8; i++) await press(i % 3 === 2 ? 'shift-tab' : 'tab')
  assert.equal(await focus(), before, 'Tab inside the open preview never reaches the window behind it')
  assert.equal(await a.getByTestId('viewer').count(), 1)
  await press('escape')
  await a.clock.fastForward(1000)
  for (let i = 0; i < 20 && await a.getByTestId('viewer').count(); i++) await a.clock.fastForward(100)
  assert.equal(await a.getByTestId('viewer').count(), 0, 'Escape closes the preview')
  console.log('ok  image preview: Tab stays inside while open, Escape closes it')
} catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }
