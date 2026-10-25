// Native verification of the Coordinator context refresh UI (`rotation.fixture.tsx`): the row's states and motion, the
// handoff card with its edit flow, the real transcript of a Coordinator thread, and the composer's context meter with its
// refresh tick. Light and dark, and Reduce Motion. Screenshots go to $KYBERN_VERIFY_OUTPUT.
//
//   bun src/transcript/rotation.verify.ts
//   KYBERN_VERIFY_NATIVE=<patched gpuix-native.node>  to exercise the paint-only motion without a local native build
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture, waitForPainted } from '../requests/harness.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/coordinator-context/e1b'
mkdirSync(out, { recursive: true })
const native = process.env.KYBERN_VERIFY_NATIVE
const HANDOFF = '## Goals\nShip expired-login handling before Friday.\n\n## Decisions\nNone\n\n## Reversals and removals\nOct 25 · Removed the pre-launch fallback in `def5678`.\n\n## User preferences\nNone\n\n## Open questions\nNone\n\n## Next steps\nWait for PR #42.'

type Fixture = Awaited<ReturnType<typeof launchFixture>>
const painted = async (f: Fixture) => (await f.app.call('getPaintedText', {})).text as string[]
const settle = async (f: Fixture, ms = 700) => { for (let t = 0; t < ms; t += 50) { await Bun.sleep(10); await f.app.clock.fastForward(50) } }
const has = async (f: Fixture, text: string) => (await painted(f)).some((line) => line.includes(text))
const count = async (f: Fixture, text: string) => (await painted(f)).filter((line) => line.includes(text)).length
async function until(f: Fixture, text: string, present = true, ms = 4000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if ((await has(f, text)) === present) return; await settle(f, 100) }
  throw new Error(`Timed out waiting for ${present ? '' : 'absence of '}painted text: ${text}\n${(await painted(f)).join('\n')}`)
}

async function launch(mode: string, theme: string, reduced: string) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-rotation-')
  const f = await launchFixture(import.meta.dir + '/rotation.fixture.tsx', {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, ROTATION_MODE: mode,
    KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '',
    ...(native && existsSync(native) ? { NAPI_RS_NATIVE_LIBRARY_PATH: native } : {}),
  })
  return { f, scratch }
}

async function rows(theme: string, reduced: string) {
  const { f, scratch } = await launch('rows', theme, reduced)
  const shot = (name: string) => reduced === '0' ? f.app.screenshot({ path: `${out}/${name}-${theme}.png` }) : Promise.resolve('')
  try {
    await f.app.getByTestId('rotation-ready').waitFor({ timeoutMs: 30000 })
    // Pending: the shimmering label, no chevron, nothing opens.
    await until(f, 'Refreshing context…')
    await settle(f, 400)
    await shot('rotation-1-pending')
    await f.app.getByTestId('rotation-toggle-live').click()
    await settle(f, 400)
    assert.equal(await f.app.getByTestId('rotation-card-live').count(), 0, 'a pending row does not open')
    // Settled in place: the label swaps, the old copy leaves.
    await f.app.getByTestId('rotation-settle').click()
    await until(f, 'Context refreshed ·')
    await until(f, 'Refreshing context…', false)
    await shot('rotation-2-settled')
    // Opened: the six sections, the meta line, "Edit handoff".
    await f.app.getByTestId('rotation-toggle-live').click()
    await f.app.getByTestId('rotation-card-live').waitFor()
    await settle(f, 500)
    for (const text of ['Handoff', 'Passed 200k tokens · carried 3 agents, 1 pull request, 5 commits', 'Goals', 'Decisions', 'Reversals and removals', 'User preferences', 'Open questions', 'Next steps', 'None', 'Edit handoff']) assert.ok(await has(f, text), `painted: ${text}`)
    assert.ok(!(await has(f, '(date, what')), "the prompt's hint is not a label")
    assert.equal(await count(f, 'Edit handoff'), 1, 'only the latest refresh offers Edit handoff')
    await shot('rotation-3-expanded')
    // Edit: a monospace field with the full markdown, hint, Cancel, Save.
    await f.app.getByTestId('rotation-edit').click()
    await f.app.getByTestId('rotation-editor').waitFor()
    await settle(f, 400)
    assert.ok(await has(f, 'The Coordinator gets your correction with your next message.'))
    assert.ok(await has(f, '## Goals'), 'the editor holds the markdown')
    for (const text of ['Cancel', 'Save handoff']) assert.ok(await has(f, text), `painted: ${text}`)
    await shot('rotation-4-edit')
    await f.app.getByTestId('rotation-cancel').click()
    await until(f, '## Goals', false)
    assert.equal(await f.app.getByTestId('rotation-editor').count(), 0)
    assert.ok(!(await has(f, 'Edited by you')), 'cancel edits nothing')
    await f.app.getByTestId('rotation-edit').click()
    await f.app.getByTestId('rotation-editor').waitFor()
    await f.app.getByTestId('rotation-editor').fill(HANDOFF)
    await settle(f, 200)
    await f.app.getByTestId('rotation-save').click()
    await until(f, 'Edited by you')
    await until(f, 'The Coordinator gets your correction', false)
    await settle(f, 500)
    assert.ok(await has(f, 'Wait for PR #42.'), 'the saved text is shown')
    await shot('rotation-5-edited')
    // The other states: no handoff, a harness switch, a manual refresh.
    await f.app.getByTestId('rotation-toggle-missing').click()
    await f.app.getByTestId('rotation-card-missing').waitFor()
    await settle(f, 500)
    for (const text of ['Context refreshed without a handoff ·', 'No handoff', 'did not answer within 90 seconds', 'carried 2 agents, 4 commits and the recent messages', 'Switched to Codex · context carried', 'Context refreshed by you ·']) assert.ok(await has(f, text), `painted: ${text}`)
    assert.equal(await count(f, 'Edit handoff'), 1, 'older and handoff-less rows have no Edit handoff')
    await f.app.getByTestId('rotation-toggle-switch').click()
    await f.app.getByTestId('rotation-card-switch').waitFor()
    await settle(f, 500)
    assert.ok(await has(f, 'Switched to Codex · carried'))
    assert.equal(await count(f, 'Edit handoff'), 1)
    await shot('rotation-6-variants')
    // Collapsing unmounts the card after its exit.
    await f.app.getByTestId('rotation-toggle-live').click()
    await settle(f, 600)
    assert.equal(await f.app.getByTestId('rotation-card-live').count(), 0)
    console.log(`PASS rows ${theme} reduced=${reduced}: pending → settled, opened, edit/cancel/save, edited label, no handoff, switch, manual`)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}

async function transcript(mode: 'transcript' | 'off', theme: string, reduced: string) {
  const { f, scratch } = await launch(mode, theme, reduced)
  const shot = (name: string) => reduced === '0' ? f.app.screenshot({ path: `${out}/${name}-${theme}.png` }) : Promise.resolve('')
  try {
    await f.app.getByTestId('rotation-ready').waitFor({ timeoutMs: 30000 })
    await waitForPainted(f.app, 'Context refreshed ·')
    await settle(f, 500)
    assert.equal(await f.app.getByTestId('rotation-toggle-r1').count(), 1)
    assert.equal(await f.app.getByTestId('rotation-toggle-r2').count(), 1)
    assert.ok(!(await has(f, 'Worked')), 'a refresh is not part of the turn that came before it')
    const a = await f.app.getByTestId('rotation-toggle-r1').bounds(), b = await f.app.getByTestId('rotation-toggle-r2').bounds()
    assert.ok(b.y > a.y + 80, 'the second refresh sits after the second turn')
    if (mode === 'transcript') {
      // The older refresh opens without Edit handoff; only the latest in the thread can be edited.
      await f.app.getByTestId('rotation-toggle-r1').click()
      await f.app.getByTestId('rotation-card-r1').waitFor()
      await settle(f, 500)
      assert.ok(await has(f, 'Reversals and removals'))
      assert.equal(await count(f, 'Edit handoff'), 0, 'an older refresh cannot be edited')
      await shot('rotation-7-transcript-older')
      // The transcript keeps the tail in view, so the opened card pushed its own row up: scroll back to it.
      for (const delta of [500, -500]) {
        if ((await f.app.getByTestId('rotation-toggle-r1').bounds()).y > 40) break
        await f.app.mouse.wheel({ x: 500, y: 400 }, 0, delta)
        await settle(f, 300)
      }
      await f.app.getByTestId('rotation-toggle-r1').click()
      await settle(f, 600)
      assert.equal(await f.app.getByTestId('rotation-card-r1').count(), 0)
      await f.app.getByTestId('rotation-toggle-r2').click()
      await f.app.getByTestId('rotation-card-r2').waitFor()
      await settle(f, 500)
      assert.equal(await count(f, 'Edit handoff'), 1, 'the latest refresh in the thread can be edited')
      await shot('rotation-8-transcript-latest')
      await f.app.getByTestId('rotation-toggle-r2').click()
      await settle(f, 600)
      // The context meter first (nothing pending): a tick on the ring and in the popover, the refresh row.
      await f.app.getByTestId('composer-status').click()
      await f.app.getByTestId('composer-status-popover').waitFor()
      await settle(f, 500)
      assert.ok(await has(f, 'Refreshes at 200k'))
      assert.ok(await has(f, 'Starts a fresh session with a handoff'))
      assert.ok(await has(f, 'Refresh now'))
      const pop = await f.app.getByTestId('composer-status-popover').bounds(), tick = await f.app.getByTestId('composer-status-tick').bounds()
      const track = pop.width - 32
      assert.ok(Math.abs(tick.x + tick.width / 2 - (pop.x + 16 + track * 0.2)) < 2.5, `tick at 20% of the track: ${JSON.stringify({ pop, tick })}`)
      assert.equal(tick.width, 2)
      await shot('rotation-9-meter')
      // Pending: the row says so and cannot open; "Refresh now" is disabled meanwhile.
      await f.app.getByTestId('rotation-pending').click()
      await until(f, 'Refreshing context…')
      await shot('rotation-10-transcript-pending')
      await f.app.getByTestId('composer-status').click()
      await f.app.getByTestId('composer-status-popover').waitFor()
      await settle(f, 500)
      await shot('rotation-11-meter-pending')
    } else {
      await f.app.getByTestId('composer-status').click()
      await f.app.getByTestId('composer-status-popover').waitFor()
      await settle(f, 500)
      assert.ok(await has(f, 'Automatic refresh is off'))
      assert.equal(await f.app.getByTestId('composer-status-tick').count(), 0, 'no tick when off')
      await shot('rotation-12-meter-off')
    }
    console.log(`PASS ${mode} ${theme} reduced=${reduced}`)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}

// ROTATION_ONLY=rows|transcript|off narrows a run while iterating.
const only = process.env.ROTATION_ONLY
for (const theme of ['dark', 'light']) {
  if (!only || only === 'rows') await rows(theme, '0')
  if (!only || only === 'transcript') await transcript('transcript', theme, '0')
  if (!only || only === 'off') await transcript('off', theme, '0')
}
if (!only || only === 'rows') await rows('dark', '1')
if (!only || only === 'transcript') await transcript('transcript', 'dark', '1')
process.exit(0)
