// Drives `knowledge.fixture.tsx` in dark and light and checks what the Coordinator's notes, map and cards say and do:
// `NAPI_RS_NATIVE_LIBRARY_PATH=<patched addon> bun src/coordinator/knowledge.verify.ts [mode…]`. Screenshots go to
// `KNOWLEDGE_OUT` (default: a temp folder). Nothing here talks to a real daemon.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const out = process.env.KNOWLEDGE_OUT ?? mkdtempSync(path.join(tmpdir(), 'gpuix-knowledge-out-'))
const themes = (process.env.KNOWLEDGE_THEMES ?? 'dark,light').split(',')
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['notes', 'map', 'editor', 'tidy', 'proposal', 'row']
mkdirSync(out, { recursive: true })
const order = (text: string, ...words: string[]) => { let at = -1; for (const word of words) { const next = text.indexOf(word, at + 1); assert.ok(next > at, `"${word}" follows the earlier words`); at = next } }
for (const theme of themes) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-knowledge-'))
  const fixture = await launchFixture(path.join(import.meta.dir, 'knowledge.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_REDUCED_MOTION: '1', KYBERN_OPAQUE: '1',
  })
  const app = fixture.app
  const settle = (ms = 400) => app.clock.fastForward(ms)
  const painted = async () => (await app.call('getPaintedText', {})).text.join('\n')
  const calls = () => existsSync(`${scratch}/calls.log`) ? readFileSync(`${scratch}/calls.log`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> }) : []
  const count = (method: string) => calls().filter((call) => call.method === method).length
  const shot = async (name: string) => { await settle(); await app.screenshot({ path: `${out}/${name}-${theme}.png` }); console.log('shot', name, theme) }
  const open = async (mode: string) => { await app.getByTestId(`fixture-${mode}`).click(); await settle(700) }
  const until = async (check: () => Promise<boolean>, what: string) => { for (let i = 0; i < 40; i++) { if (await check()) return; await settle(200); await Bun.sleep(50) } throw new Error(`Timed out waiting for ${what}`) }
  try {
    await app.getByTestId('fixture-ready').waitFor({ timeoutMs: 20000 })
    // The first switch after launch races the window's activation; warm up on another mode.
    await open('row')
    for (const mode of modes) {
      await open(mode)
      if (mode === 'notes') {
        await app.getByTestId('dock-notes').waitFor({ timeoutMs: 10000 })
        await until(async () => (await painted()).includes('Expired login handling'), 'the notes list')
        const text = await painted()
        order(text, 'Preferences', 'Onboarding copy', 'Decisions', 'Expired login handling', 'Gotchas', 'Supabase RLS on profiles', 'Other', 'Release checklist', 'Undated', 'Lovable export notes')
        assert.ok(text.includes('May be outdated · session.ts changed'), 'a stale row names the changed file')
        assert.ok(text.includes('May be outdated · 20261021_profiles.sql changed'), 'the second stale row names its file')
        assert.ok(text.includes('Undated, before Oct 25'), 'an undated row says before when categories began')
        assert.equal(await app.getByTestId('dock-note-stale-n-auth').count(), 1, 'a stale row carries its warning dot line')
        assert.equal(await app.getByTestId('dock-note-stale-n-sess').count(), 0, 'a note with no flag keeps its preview')
        assert.ok(text.includes('Map') && text.includes('Project'), 'the strip has the Project and Map tabs on a Coordinator thread')
      }
      if (mode === 'map') {
        await app.getByTestId('dock-map').waitFor({ timeoutMs: 10000 })
        await until(async () => (await painted()).includes('Busy areas'), 'the map')
        const text = await painted()
        assert.ok(/As of\s+def5678\s+on main/.test(text.replace(/\n/g, ' ')) && text.includes('built from git'), 'the header says which commit, branch and age')
        order(text, 'Layout', 'src/app', 'Commands', 'pnpm dev', 'Busy areas', 'src/auth', 'Removed and renamed', 'src/auth/prelaunch.ts')
        assert.ok(text.includes('src/lib/supabase.ts → supabase/client.ts') && text.includes('def5678') && text.includes('Oct 25'), 'a rename shows both paths and a deletion its commit and date')
        assert.equal(await app.getByTestId('dock-map-busy-3').count(), 1, 'every busy area is a row')
        await shot(mode)
        const before = count('projects.map')
        await app.getByTestId('dock-map-rebuild').click(); await settle(600)
        await until(async () => count('projects.map') > before, 'the rebuild to ask for the map again')
        // A row that is a path shows it in Explorer.
        const row = app.getByTestId('dock-map-busy-0')
        await row.click(); await settle(700)
        assert.ok(!(await painted()).includes('Busy areas'), 'a path row leaves the map for Explorer')
        continue
      }
      if (mode === 'editor') {
        await app.getByTestId('note-editor').waitFor({ timeoutMs: 10000 })
        await until(async () => (await app.getByTestId('note-stale-banner').count()) === 1, 'the stale banner')
        await until(async () => (await app.getByTestId('note-superseded-veil').count()) === 1, 'the retired claim to be found')
        const text = await painted()
        assert.ok(text.includes('May be outdated') && text.includes('src/auth/session.ts') && text.includes('f19b20c'), 'the banner names the file and commit')
        assert.ok(text.includes('Decision'), 'the category shows in the meta row')
        assert.equal(await app.getByTestId('note-superseded-label').count(), 1, 'the margin label shows when there is room')
        assert.ok(text.includes('Superseded Oct 25'), 'the label names the day the claim was retired')
        await shot(mode)
        await app.getByTestId('note-category-trigger').click(); await settle(500)
        assert.equal(await app.getByTestId('note-category-convention').count(), 1, 'the picker lists the categories')
        await shot('editor-category-menu')
        await app.getByTestId('note-category-convention').click(); await settle(700)
        await until(async () => calls().some((call) => call.method === 'notes.update' && call.params.category === 'convention'), 'the category to be saved')
        await until(async () => (await painted()).includes('Convention'), 'the new category')
        continue
      }
      if (mode === 'tidy') {
        await app.getByTestId('tidy-notes-card').waitFor({ timeoutMs: 10000 })
        const text = await painted()
        for (const line of ['5 notes may be outdated', 'Files they cite changed after they were written.', 'An agent checks them. You approve each change.', 'Not now', 'Tidy notes']) assert.ok(text.includes(line), `the card says "${line}"`)
        await shot(mode)
        await app.getByTestId('tidy-start').click(); await settle(600)
        await until(async () => count('notes.tidy_start') === 1, '"Tidy notes" to start')
        await until(async () => (await app.getByTestId('tidy-notes-card').count()) === 0, 'the card to leave')
        await open('tidy')
        await app.getByTestId('tidy-notes-card').waitFor({ timeoutMs: 10000 })
        await app.getByTestId('tidy-not-now').click(); await settle(600)
        await until(async () => count('notes.tidy_snooze') === 1, '"Not now" to snooze')
        await until(async () => (await app.getByTestId('tidy-notes-card').count()) === 0, 'the card to leave after Not now')
        continue
      }
      if (mode === 'proposal') {
        await app.getByTestId('coordinator-card').waitFor({ timeoutMs: 10000 })
        const text = await painted()
        for (const line of ['Apply 3 note changes?', 'Expired login handling', 'Supabase RLS on profiles', 'Session storage', 'Apply 3 changes', 'Decline', 'expired sessions fall back to /pre-launch']) assert.ok(text.includes(line), `the card shows "${line}"`)
        order(text, 'expired sessions fall back to /pre-launch', 'expired sessions redirect to /sign-in')
        await shot(mode)
        await app.getByTestId('coordinator-note-1').click(); await settle(400)
        assert.ok((await painted()).includes('Apply 2 changes'), 'unticking a row lowers the count')
        await shot('proposal-unticked')
        await app.getByTestId('coordinator-accept').click(); await settle(600)
        await until(async () => calls().some((call) => call.method === 'approvals.respond'), 'the answer')
        const answer = calls().find((call) => call.method === 'approvals.respond')!
        assert.deepEqual((answer.params.response as { accepted: string[] }).accepted, ['0', '2'], 'the answer lists the ticked rows')
        continue
      }
      if (mode === 'row') {
        const text = await painted()
        assert.ok(text.includes('Tidy notes') && !text.includes('You approve each change'), 'the transcript row says "Tidy notes"')
      }
      await shot(mode)
    }
    console.log(`PASS ${theme}: ${modes.join(', ')}`)
  } catch (error) { await app.screenshot({ path: `${out}/failed-${theme}.png` }).catch(() => {}); console.error(fixture.diagnostics()); throw error } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
console.log(`screenshots in ${out}`)
process.exit(0)
