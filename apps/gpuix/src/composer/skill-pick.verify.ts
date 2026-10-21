// Picking a skill from the `$` menu (v0.10.1 crash: "Selection must use ordered UTF-16 character boundaries" from the caret
// restore, which replaced the window with the fatal error screen). Every pick, by Enter and by mouse, after plain text,
// emoji and nothing, with and without text after the caret, must: never log a rejected caret restore or a runtime error,
// paint the chip at once, and leave the caret right after the chip (a typed marker lands there).
//   bun src/composer/skill-pick.verify.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/chatfix2/skill-pick'
mkdirSync(out, { recursive: true })
const until = async (check: () => Promise<boolean>, label: string) => { for (let i = 0; i < 100; i++) { try { if (await check()) return } catch {} await Bun.sleep(40) } throw Error(`Timed out: ${label}`) }
const skills = [
  { query: 'better', label: 'interfaces:better-layout', row: 'Grouping, alignment' },
  { query: 'tresh', label: 'treshnanda-taste', row: 'Personal taste profile' },
  { query: 'rev', label: 'review-ui', row: 'Review an interface change' },
]
const befores = (process.env.SKILL_PICK_BEFORES ? JSON.parse(process.env.SKILL_PICK_BEFORES) : ['', 'hello ', '👋🏽 emoji 🎉 ']) as string[]
const variants = (process.env.SKILL_PICK_VARIANTS ?? 'dark,light').split(',')
let failures = 0, runs = 0
for (const variant of variants) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-skill-pick-')
  let log = ''
  const f = await launchFixture(import.meta.dir + '/conversation.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '' }, { stderr: chunk => { log += chunk } })
  try {
    const app = f.app, composer = app.getByTestId('composer')
    await app.getByTestId('conversation-ready').waitFor()
    await until(async () => (await app.getByTestId('connected').textContent()) === 'open', 'connected')
    const painted = async () => String((await app.call('getPaintedText', {})).text)
    const menu = async () => (await app.getByTestId('completion').count()) > 0
    for (const skill of skills) for (const before of befores) for (const how of ['enter', 'mouse'] as const) for (const after of process.env.SKILL_PICK_TAIL === '0' ? [''] : ['', ' tail']) {
      runs++
      const name = `${variant}/${skill.label}/${JSON.stringify(before)}/${how}/${after ? 'tail' : 'end'}`
      const mark = log.length
      await composer.fill(before + '$' + skill.query + after)
      for (let i = 0; i < after.length; i++) await composer.press('left')
      await Bun.sleep(60)
      await until(menu, `menu ${name}`)
      await until(async () => (await painted()).includes(skill.row), `row ${name}`)
      if (how === 'enter') await composer.press('enter')
      else await app.getByTestId('completion-selected').click()
      await until(async () => !(await menu()), `menu closed ${name}`)
      await Bun.sleep(120)
      await composer.press('Z')
      await Bun.sleep(160)
      const text = await painted()
      const fresh = log.slice(mark)
      const problems = [
        /caret restore skipped|Selection must use|runtime error/.test(fresh) && `logged: ${fresh.match(/.*(caret restore skipped|Selection must use|runtime error).*/)?.[0]}`,
        text.includes('Uncaught runtime errors') && 'fatal error screen',
        !text.includes(`  ${skill.label} Z`) && `caret not after chip: ${JSON.stringify(text.slice(Math.max(0, text.indexOf(skill.label) - 4), text.indexOf(skill.label) + skill.label.length + 12))}`,
        // With text after the caret, the existing space stands in for the chip's own, and the caret lands after it.
        after && !text.includes(`  ${skill.label} Z${after.trimStart()}`) && 'tail moved',
      ].filter(Boolean)
      if (problems.length) { failures++; console.log(`FAIL ${name}: ${problems.join('; ')}`); await app.screenshot({ path: `${out}/fail-${runs}-${variant}.png` }) }
      else console.log(`ok   ${name}`)
      if (text.includes('Uncaught runtime errors')) throw Error('window replaced by the fatal error screen')
    }
    await composer.fill('👋🏽 emoji 🎉 $better')
    await until(menu, 'menu final'); await composer.press('enter'); await until(async () => !(await menu()), 'closed final')
    await Bun.sleep(250)
    await app.screenshot({ path: `${out}/picked-${variant}.png` })
  } catch (error) { failures++; await f.app.screenshot({ path: `${out}/failed-${variant}.png` }).catch(() => {}); console.log(String(error)); console.log(log.slice(-3000)) } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
console.log(`${runs - failures}/${runs} picks clean`)
process.exit(failures ? 1 : 0)
