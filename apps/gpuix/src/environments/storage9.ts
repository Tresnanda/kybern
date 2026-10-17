/**
 * settings9 item 5: per-environment local storage. Two real scratch daemons (A, B). Each environment keeps its
 * own composer draft, open thread, last page, sidebar state and notes; switching, relaunching and forgetting
 * behave like the desktop's `kybern.workspace.v1:<environment>`.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { addSecond, CLIENT, DATA_A, DATA_B, ensureThread, mode, reset, start, switchTo, wait } from './verify9.lib.ts'
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(`FAIL: ${message}`); console.log(`ok  ${message}`) }
const a1 = ensureThread(DATA_A, 'Thread A1'), b1 = ensureThread(DATA_B, 'Thread B1'), b2 = ensureThread(DATA_B, 'Thread B2')
reset()
let h = await start()
const count = async (value: string) => JSON.stringify(await h.app.call('getPaintedText', {})).split(value).length - 1
/** A thread is open when its title shows in the header as well as in the sidebar row. */
const open = async (title: string) => (await count(title)) >= 2
try {
  await wait(1200)
  const bId = await addSecond(h)
  // B: open Thread B2 and leave a draft in a *new chat* is not possible at once: the draft belongs to the open view.
  await h.click(`thread-${b2}`); await h.until('B2 open', () => open('Thread B2')); await wait(500)
  await h.app.getByTestId('composer').fill('reply draft in B2')
  await wait(500)
  await switchTo(h, 'local', 'proj9a')
  assert(!(await open('Thread B2')) && !(await h.text('reply draft in B2')), 'A shows nothing of B')
  await h.click(`thread-${a1}`); await h.until('A1 open', () => open('Thread A1')); await wait(500)
  await h.app.getByTestId('composer').fill('reply draft in A1')
  await wait(500)
  await h.shot('s-01-A-thread')
  await switchTo(h, bId, 'proj9b')
  await h.until('B2 reopened', () => open('Thread B2'), 15000)
  assert(await open('Thread B2'), 'B reopens the thread it was showing')
  assert(await h.text('reply draft in B2') && !(await h.text('reply draft in A1')), 'B restores its own reply draft only')
  await h.shot('s-02-B-restored')
  await switchTo(h, 'local', 'proj9a')
  await h.until('A1 reopened', () => open('Thread A1'), 15000)
  assert(await h.text('reply draft in A1') && !(await h.text('reply draft in B2')), 'A restores its own thread and reply draft')
  // Notes page and the sidebar collapsed state belong to the environment too.
  await h.click('rail-notes'); await wait(700)
  await switchTo(h, bId, 'proj9b')     // goes via Home: the saved view is whatever Home showed last
  await wait(400)
  await h.click('rail-tasks'); await wait(900)
  await h.app.close()
  // Relaunch straight into B: it returns to its last page (Tasks).
  h = await start({ KYBERN_GPUIX_ENVIRONMENT: bId })
  await h.until('B tasks page', () => h.present('task-new'), 30000)
  assert(await h.present('task-new'), 'relaunching into B restores its last page (Tasks)')
  await h.click('rail-home'); await wait(500)
  await h.app.close()
  h = await start()
  await h.until('A back', () => h.text('proj9a'), 30000); await wait(800)
  assert(await open('Thread A1') && await h.text('reply draft in A1'), 'relaunching into A restores its last view and draft')
  // Forget B: its stored UI state goes with it (desktop forgetEnvironmentStore).
  // `savedEnvironmentStateFile` / `prefsFileFor`: the files keyed by B's id, next to A's own.
  const hash = (key: string) => createHash('sha1').update(key).digest('hex').slice(0, 12)
  const bFiles = [path.join(DATA_A, `gpuix-ui-${hash(bId)}.json`), path.join(CLIENT, `workspace-${hash(bId)}.json`)]
  const aFiles = [path.join(DATA_A, 'gpuix-ui.json'), path.join(CLIENT, `workspace-${hash(DATA_A)}.json`)]
  assert(bFiles.every(f => existsSync(f)) && aFiles.every(f => existsSync(f)), 'A and B each have their own saved UI state files')
  await h.click('rail-home'); await h.click('environment-switcher'); await h.click('environment-manage'); await h.click(`environment-forget-${bId}`)
  await h.until('B forgotten', async () => !(await h.present(`environment-forget-${bId}`)), 10_000); await wait(900)
  assert(bFiles.every(f => !existsSync(f)), 'forgetting B removed its saved UI state files')
  assert(aFiles.every(f => existsSync(f)), "forgetting B kept A's saved UI state")
  console.log(`PASS per-environment storage (${mode}${process.env.KYBERN_REDUCED_MOTION === '1' ? ', reduced motion' : ''})`)
} catch (e) { await h.shot('s-failure'); throw e } finally { await h.app.close().catch(() => {}) }
