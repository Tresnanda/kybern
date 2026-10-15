import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'native-motion-lab.tsx')], env: { NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  const at = await app.clock.pause()
  const start = await app.getByTestId('spring').bounds()
  const sibling = await app.getByTestId('sibling').bounds()
  await app.getByTestId('toggle').click()
  await app.clock.set(at + 300)
  const peak = await app.getByTestId('spring').bounds()
  assert(peak.x > start.x + 205, `spring should overshoot: ${JSON.stringify({ start, peak })}`)
  assert(peak.y > start.y + 20, 'translateY should overshoot too')
  assert.deepEqual(await app.getByTestId('sibling').bounds(), sibling, 'translation moved sibling layout')
  await app.clock.set(at + 1000)
  const end = await app.getByTestId('spring').bounds()
  assert(Math.abs(end.x - start.x - 200) < 1)
  assert(Math.abs(end.y - start.y - 20) < 1)
  await app.getByTestId('spring').click()
  await app.getByText('Clicks 1').waitFor()
  await app.getByText('Settled 1').waitFor()
  console.log(`ok  native spring overshoots ${(peak.x - start.x - 200).toFixed(1)}px, settles exactly, preserves layout and translated hitboxes`)
} finally { await app.close() }
