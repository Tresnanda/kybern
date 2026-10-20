import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'code-wrap-lab.tsx')], env: { NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  const plain = await app.getByTestId('plain').bounds()
  const wrapped = await app.getByTestId('wrapped').bounds()
  assert(wrapped.height > plain.height * 2, `wrapped height ${wrapped.height}; plain ${plain.height}`)
  assert(wrapped.width <= 301, `wrapped width ${wrapped.width}`)
  const painted = (await app.call('getPaintedText', {})).text.join('')
  assert(painted.includes('你好 🌱') && painted.includes('return message;') && painted.includes('WithoutBreaks'.repeat(12)), 'wrapped code lost painted content')
  if (process.argv[2]) await app.screenshot({ path: process.argv[2] })
  console.log(`ok  highlighted code wraps within 300px (${plain.height}px → ${wrapped.height}px tall), including long tokens and Unicode`)
} finally { await app.close() }
