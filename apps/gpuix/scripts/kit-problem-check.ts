// On-screen check of the Problem component (`src/kit/Problem.tsx`, issue #231) on the kit gallery's `problem` section: the three forms
// (`ProblemState`, `ProblemRow`, `toast.problem`) by their title and button test ids, the Show details disclosure and its copy button
// (the text reaches the system clipboard), and Reduce Motion (the content is on screen with no entrance to wait for).
//   bun scripts/kit-problem-check.ts            (PNGs go to KYBERN_VERIFY_OUTPUT, else native/build/kit-problem)
import assert from 'node:assert/strict'
import path from 'node:path'
import { capture, launch, outputDir, settled, step, type Fixture } from '../native/check-harness.ts'

const out = outputDir('kit-problem')

const TITLE = 'Install GitHub CLI to see pull requests'
const DETAIL = 'exec: "gh": executable file not found in %PATH%'

/** The system clipboard's text, or `null` where this machine has no tool to read it. */
function clipboard(): string | null {
  const read = process.platform === 'win32' ? ['powershell', '-NoProfile', '-Command', 'Get-Clipboard -Raw'] : process.platform === 'darwin' ? ['pbpaste'] : ['sh', '-c', 'xclip -selection clipboard -o 2>/dev/null || wl-paste 2>/dev/null']
  const result = Bun.spawnSync(read, { stdout: 'pipe', stderr: 'ignore' })
  return result.exitCode === 0 ? result.stdout.toString() : null
}

async function run(reduced: boolean) {
  const mode = reduced ? 'reduced' : 'motion'
  const f: Fixture = await launch(path.join(import.meta.dir, 'kit9-gallery-entry.tsx'), { KIT_SECTION: 'problem', KYBERN_APPEARANCE: 'dark', KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: reduced ? '1' : '0' })
  const a = f.app
  const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
  const count = (id: string) => a.getByTestId(id).count()
  const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 5000 }); await a.getByTestId(id).click() }
  const pressed = () => a.getByTestId('pressed').textContent()
  try {
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })

    await step(`${mode}: the title is on screen`, async () => {
      // Reduce Motion has no entrance (`EmptyHeader` plays nothing): two frames in, every part is already painted, in one read. With motion the
      // header rises in over about half a second, so poll for it.
      if (reduced) await a.clock.fastForward(50)
      const text = reduced ? await painted() : await settled(painted, (t) => t.includes(TITLE), 4000)
      assert.ok(text.includes(TITLE), `the headline "${TITLE}" is painted`)
      assert.ok(text.includes('Kybern reads pull requests'), 'and its one sentence')
      assert.ok(!text.includes(DETAIL), 'the technical text stays behind Show details')
      assert.ok(!/RpcCallError|program not found/.test(text), 'no raw error')
      for (const title of ['Claude Code is signed out', 'SatyaMas is offline', 'Windows build failed', 'Couldn’t start the thread on SatyaMas']) assert.ok(text.includes(title), `${title} is painted`)
    })

    await step(`${mode}: the buttons have test ids and run`, async () => {
      for (const id of ['state-0-primary', 'state-0-secondary', 'state-1-primary', 'state-2-primary', 'row-0-primary', 'row-0-secondary', 'row-2-primary', 'toast-action', 'toast-secondary']) assert.equal(await count(id), 1, `${id} is on screen`)
      assert.equal(await count('state-2-secondary'), 0, 'a problem with one action has no second button')
      await click('state-0-primary')
      assert.equal(await settled(pressed, (v) => v === 'state-0-primary'), 'state-0-primary')
      await click('row-0-secondary')
      assert.equal(await settled(pressed, (v) => v === 'row-0-secondary'), 'row-0-secondary')
    })

    await step(`${mode}: Show details opens the technical text and its copy button`, async () => {
      assert.equal(await count('state-0-copy'), 0, 'no copy button while the details are closed')
      await click('state-0-details')
      const text = await settled(painted, (t) => t.includes(DETAIL))
      assert.ok(text.includes(DETAIL), 'the technical text shows once opened')
      assert.ok(text.includes('Hide details'), 'and the disclosure says how to close it')
      assert.equal(await count('state-0-copy'), 1, 'with a copy button')
      await capture(f, path.join(out, `${mode}-details.png`))
      await click('state-0-copy')
      const copied = await settled(async () => clipboard(), (v) => v === null || v.includes(DETAIL), 4000)
      if (copied === null) console.log('note: no clipboard reader on this machine, the copied text is not asserted')
      else assert.ok(copied.includes(DETAIL), `Copy puts the technical text on the clipboard (got ${JSON.stringify(copied.slice(0, 80))})`)
      await click('state-0-details')
      const closed = await settled(painted, (t) => !t.includes(DETAIL))
      assert.ok(!closed.includes(DETAIL), 'Hide details closes it again')
      assert.equal(await count('state-0-copy'), 0)
      // A row has the same disclosure.
      await click('row-0-details')
      assert.ok((await settled(painted, (t) => t.includes('OAuth token expired'))).includes('OAuth token expired'), 'a row opens its details too')
      assert.equal(await count('row-0-copy'), 1)
    })

    await step(`${mode}: the toast's secondary closes it`, async () => {
      assert.ok((await painted()).includes('Copy'), 'the toast shows its Copy button')
      await click('toast-secondary')
      assert.equal(await settled(pressed, (v) => v === 'toast-secondary'), 'toast-secondary')
      await settled(() => count('toast-secondary'), (n) => n === 0, 3000)
      assert.equal(await count('toast-secondary'), 0, 'the toast leaves after Copy')
    })
    await capture(f, path.join(out, `${mode}-final.png`))
  } catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }
}

await run(false)
await run(true)
console.log('ok  kit-problem-check')
process.exit(0)
