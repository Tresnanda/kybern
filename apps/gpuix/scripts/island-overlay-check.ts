import '../src/native/local-build.ts'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'island-lab.tsx'), 'island'], env: { ISLAND_LAB_OVERLAY: '1', NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  for (let i = 1; i <= 3; i++) {
    await app.getByTestId('outside-update').click()
    await app.getByText(`Outside ${i}`).waitFor()
    await app.getByTestId('island-overlay').click()
    await app.getByText(`Overlay clicks ${i}`).waitFor()
  }
  console.log('ok  deferred overlay bounds and clicks survive cached replay')
} finally { await app.close() }
