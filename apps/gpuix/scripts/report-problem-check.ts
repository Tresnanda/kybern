// On-screen check of "Report a problem" (#235): the action is quiet (only inside Show details), opens a review sheet whose text has
// no local path, user name, e-mail address or token, lets the person edit it, and opens the GitHub issue only on confirm.
//   bun scripts/report-problem-check.ts [out-dir]       (PNGs of the sheet, light and dark, go to out-dir)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { launch, settled, step } from '../native/check-harness.ts'

const out = process.argv[2] ?? path.join(tmpdir(), 'report-problem-check')
mkdirSync(out, { recursive: true })
const user = userInfo().username

async function run(look: 'light' | 'dark') {
  const log = path.join(tmpdir(), `kybern-open-url-${process.pid}-${look}.log`)
  rmSync(log, { force: true })
  const f = await launch(path.join(import.meta.dir, 'report-problem-entry.tsx'), { KYBERN_APPEARANCE: look, KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1', KYBERN_OPEN_URL_LOG: log })
  const a = f.app
  const count = (id: string) => a.getByTestId(id).count()
  const lines = async (): Promise<string[]> => (await a.call('getPaintedText', {})).text
  const painted = async () => (await lines()).join('\n')
  const opened = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])
  try {
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })

    await step(`${look}: Report a problem is only inside Show details`, async () => {
      assert.equal(await count('state-report'), 0, 'no report button while the details are closed')
      await a.getByTestId('state-details').click()
      await settled(() => count('state-report'), (n) => n === 1)
      assert.equal(await count('state-report'), 1, 'it appears with the details')
      assert.ok((await painted()).includes('Report a problem'))
    })

    await step(`${look}: the sheet shows the issue with everything personal stripped`, async () => {
      await a.getByTestId('state-report').click()
      await a.getByTestId('report-body').waitFor({ timeoutMs: 10_000 })
      await Bun.sleep(300)
      const shown = await lines()
      const body = shown.find((line) => line.includes('**Problem**')) ?? ''
      assert.equal(shown.filter((line) => line === "Couldn't load pull requests").length, 2, 'the headline is the issue title (once on the page, once in the sheet)')
      for (const found of ['**Problem**', '- internal', '**Technical detail**', '**This computer**', 'Kybern ']) assert.ok(body.includes(found), `the issue has ${found}:\n${body}`)
      for (const marker of ['<path>', '<email>', '<secret>']) assert.ok(body.includes(marker), `the issue has ${marker}:\n${body}`)
      for (const leak of [user, 'C:\\Users', '/Users/', 'ghp_', '@example.com']) assert.ok(!body.toLowerCase().includes(leak.toLowerCase()), `${leak} is not in the issue:\n${body}`)
      assert.equal(opened().length, 0, 'nothing is opened before the person confirms')
      await Bun.sleep(300)
      await a.screenshot({ path: path.join(out, `report-sheet-${look}.png`) })
    })

    await step(`${look}: Cancel opens nothing`, async () => {
      await a.getByTestId('report-cancel').click()
      await settled(() => count('report-title'), (n) => n === 0)
      assert.equal(await count('report-title'), 0, 'the sheet is gone')
      assert.equal(opened().length, 0, 'and nothing was opened')
    })

    await step(`${look}: the edited text is what opens on GitHub`, async () => {
      await a.getByTestId('state-report').click()
      await a.getByTestId('report-title').waitFor({ timeoutMs: 10_000 })
      await a.getByTestId('report-title').fill('Pull requests will not load')
      await a.getByTestId('report-body').fill('**What I was doing**\n\nOpening the pull requests page.')
      await a.getByTestId('report-open').click()
      const urls = await settled(async () => opened(), (v) => v.length > 0)
      assert.equal(urls.length, 1)
      const url = new URL(urls[0]!)
      assert.equal(`${url.origin}${url.pathname}`, 'https://github.com/Tresnanda/kybern/issues/new')
      assert.equal(url.searchParams.get('title'), 'Pull requests will not load')
      assert.equal(url.searchParams.get('body'), '**What I was doing**\n\nOpening the pull requests page.')
      await settled(() => count('report-title'), (n) => n === 0)
      assert.equal(await count('report-title'), 0, 'the sheet closes after it opens the issue')
    })
  } catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close(); rmSync(log, { force: true }) }
}

await run('light')
await run('dark')
console.log('ok  report-problem-check')
process.exit(0)
