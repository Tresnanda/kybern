import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const clipboard = () => execFileSync('pbpaste', { encoding: 'utf8' })
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'secure-input-lab.tsx')], env: { NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await app.getByText('Characters 3').waitFor()
  const info = await app.call('initialize', { protocolVersion: 1, client: 'secure-input-check' })
  if (process.env.NATIVE_AX_TEST === '1') console.log(execFileSync('xcrun', ['swift', path.join(import.meta.dir, 'native-window.swift'), String(info.pid), 'accessibility'], { encoding: 'utf8' }).trim())
  const tree = JSON.stringify(await app.call('getTree', {}))
  assert(!tree.includes('a😀é'), 'secure value leaked into inspection tree')
  assert(!JSON.stringify(await app.call('getPaintedText', {})).includes('a😀é'), 'secure value leaked into painted text')
  assert.equal(await app.getByTestId('secret').textContent(), '')
  const before = clipboard()
  await app.getByTestId('secret').press('cmd-a')
  await app.getByTestId('secret').press('cmd-c')
  assert.equal(clipboard(), before, 'secure copy changed clipboard')
  await app.getByTestId('secret').press('cmd-x')
  assert.equal(clipboard(), before, 'secure cut changed clipboard')
  await app.getByText('Characters 3').waitFor()
  await app.getByTestId('secret').press('cmd-right')
  await app.getByTestId('secret').press('backspace')
  await app.getByText('Characters 2').waitFor()
  await app.getByTestId('secret').press('backspace')
  await app.getByText('Characters 1').waitFor()
  await app.getByTestId('secret').press('cmd-z')
  await app.getByText('Characters 3').waitFor()
  console.log('ok  secure input masks inspection/paint, blocks copy/cut, preserves Unicode editing and undo')
} finally { await app.close() }
