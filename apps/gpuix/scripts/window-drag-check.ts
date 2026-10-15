import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'native-lab.tsx')], env: { NATIVE_POINTER_TEST: '1', NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await app.getByTestId('front').click()
  const info = await app.call('initialize', { protocolVersion: 1, client: 'native-drag-check' })
  for (const mode of ['drag', 'zoom']) {
    const bounds = await app.getByTestId('drag').bounds()
    const output = execFileSync('xcrun', ['swift', path.join(import.meta.dir, 'native-pointer.swift'), String(info.pid), String(bounds.x + bounds.width - 40), String(bounds.y + bounds.height / 2), String((await app.getByTestId('app-ready').bounds()).height), mode], { encoding: 'utf8' })
    console.log(output.trim())
  }
  await app.getByTestId('button').click()
  await app.getByText('Clicks 1').waitFor()
  console.log('ok  titlebar button remains clickable after native window gestures')
} finally { await app.close() }
