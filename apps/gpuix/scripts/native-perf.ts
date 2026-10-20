// Run against a scratch daemon and an explicitly selected thread. One window at a time.
import '../src/native/local-build.ts'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const label = process.argv[2] ?? 'Patched'
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, process.env.NATIVE_PERF_FIXTURE === '1' ? 'native-perf-fixture.tsx' : '../src/main.tsx')], env: {
  GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR!,
  KYBERN_GPUIX_THREAD: process.env.KYBERN_GPUIX_THREAD!, KYBERN_LOADER_TICK_MS: '200',
  NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH!,
  KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark',
} })
try {
  console.log('waiting for app')
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  console.log('waiting for composer')
  await app.getByTestId('composer').waitFor({ timeoutMs: 60_000 })
  console.log('waiting for workload')
  if (process.env.NATIVE_PERF_ACTIVE === '1') await app.getByTestId('working-header').waitFor({ timeoutMs: 60_000 })
  const info = await app.call('initialize', { protocolVersion: 1, client: 'native-perf' })
  // Sampling is deliberately timed; UI readiness above is condition based.
  if (process.env.NATIVE_PERF_WARMUP) {
    const warmup = Bun.spawn(['bun', path.join(import.meta.dir, '../perf/sample.ts'), process.env.NATIVE_PERF_WARMUP, `Warmup=${info.pid}`], { stdout: 'ignore', stderr: 'inherit' })
    if (await warmup.exited !== 0) throw new Error('warmup failed')
  }
  const sample = Bun.spawn(['bun', path.join(import.meta.dir, '../perf/sample.ts'), '15', `${label}=${info.pid}`], { stdout: 'inherit', stderr: 'inherit' })
  if (await sample.exited !== 0) throw new Error('sample failed')
  if (process.env.NATIVE_PERF_ACTIVE === '1') await app.getByTestId('working-header').waitFor({ timeoutMs: 1000 })
  if (process.env.NATIVE_SCREENSHOT) await app.screenshot({ path: process.env.NATIVE_SCREENSHOT })
} finally { await app.close() }
