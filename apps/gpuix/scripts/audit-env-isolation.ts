// Audit-only isolated paths and fixture project label; run with separate global-note preference.
// Notes and Tasks data stay with their environment across in-process switches.
// Setup (scratch only): environment A is the GPUIX scratch daemon (`<S>/data`) with
// a global note "Isolation probe note A" and task "Isolation probe task A"; B is a
// second scratch daemon on 4227 (`<S>/data-b`, project `env-b-project`) listed as
// `scratch-b` in `<S>/env-client/environments.json`, its token in
// `<S>/env-creds/scratch-b.token`. Never point this at a real daemon or Keychain.
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR!, KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR!, KYBERN_GPUIX_CREDENTIALS_DIR: process.env.KYBERN_GPUIX_CREDENTIALS_DIR! } })
const until = async (label: string, check: () => Promise<boolean>, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await check()) return } catch {} await wait(50) } throw new Error(`Timed out: ${label}`) }
const has = (text: string) => app.getByText(text).count().then((n) => n > 0)
const click = async (id: string) => { await until(id, async () => (await app.getByTestId(id).count()) > 0); await app.getByTestId(id).click() }
const switchTo = async (id: string, marker: string) => { await click('rail-home'); await click('environment-switcher'); await click(`environment-choice-${id}`); await until(`switched to ${id}`, () => has(marker)) }
try {
  await until('sidebar', () => has('scratch-project'), 60000)
  await click('rail-notes'); await until('note A visible in A', () => has('Isolation probe note A'))
  await click('rail-tasks'); await click('task-filter-all'); await until('task A visible in A', () => has('Isolation probe task A'))
  await switchTo('scratch-second', 'Second environment')
  await click('rail-notes'); await wait(2500)
  if (await has('Isolation probe note A')) throw new Error('LEAK: note from A shown in B')
  await click('rail-tasks'); await wait(2500)
  if (await has('Isolation probe task A')) throw new Error('LEAK: task from A shown in B')
  console.log('B shows no notes or tasks from A')
  await switchTo('local', 'scratch-project')
  await click('rail-notes'); await until('note A back in A', () => has('Isolation probe note A'))
  await click('rail-tasks'); await until('task A back in A', () => has('Isolation probe task A'))
  console.log('PASS: Notes and Tasks follow their environment')
} catch (e) {
  await app.screenshot({ path: '/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted/env-failure.png' })
  throw e
} finally {
  await app.close()
}
