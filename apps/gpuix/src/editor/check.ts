// The shared editor, used like a writer uses it, in the four modes (dark/light × Reduce
// Motion off/on): typing, Markdown shortcuts, the slash menu, formatting as its own undo
// step, typing grouped into one, checklist clicks, selection across blocks, rich and plain
// paste, the live task chip, ⌘-click on a link, input-method composition, and one block
// reshaped per keystroke. Asserts the Markdown the editor writes back.
//
//   bun src/editor/check.ts            (screenshots go to KYBERN_VERIFY_OUTPUT)
import '../native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/editor9/check'
const scratch = process.env.KYBERN_EDITOR_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/phase2-editor9'
mkdirSync(out, { recursive: true })
const modes = (process.env.KYBERN_EDITOR_MODES ?? 'dark:0,light:0,dark:1,light:1').split(',').map(m => m.split(':') as [string, string])

type Block = { top: number; height: number; tx: number; ty: number; listX: number; lineHeight: number; chips: number[][]; links: number[][] }

for (const [appearance, reduced] of modes) {
  const mode = `${appearance}-reduce-${reduced}`
  const f = await launchFixture(path.join(import.meta.dir, 'lab.tsx'), { KYBERN_APPEARANCE: appearance, KYBERN_REDUCED_MOTION: reduced, GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: `${scratch}/lab-data`, KYBERN_CLIENT_CONFIG_DIR: `${scratch}/lab-client`, KYBERN_URL: '' })
  const a = f.app
  const editor = a.getByTestId('editor')
  const text = async (id: string) => await a.getByTestId(id).textContent()
  const source = async () => JSON.parse(await text('editor-source')) as string
  const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 4000): Promise<T> => {
    const deadline = Date.now() + ms
    let value = await read()
    while (!ok(value)) { if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(value).slice(-400)}`); await Bun.sleep(25); value = await read() }
    return value
  }
  const tail = (expected: string) => until(source, s => s.endsWith(expected), `Markdown should end with ${JSON.stringify(expected)}`)
  const type = async (s: string) => { for (const ch of s) await editor.press(ch === ' ' ? 'space' : ch) }
  const debug = async () => { await a.getByTestId('lab-publish').click(); return JSON.parse(await text('editor-debug')) as { layout: { x: number; y: number; blocks: Block[] }; selection: { composing: boolean } } }
  try {
    await editor.waitFor()
    await until(async () => (await a.call('getPaintedText', {})).text.join('\n'), t => t.includes('Release checklist') && t.includes('ADE-14'), 'formatted text painted')
    await a.screenshot({ path: path.join(out, `open-${mode}.png`) })
    // The lab's hidden debug texts hold the raw Markdown; the editor's own paint does not.
    const painted = (await a.call('getPaintedText', {})).text.filter(t => !t.startsWith('"') && !t.startsWith('{') && !t.startsWith('[')).join('\n')
    assert.ok(!painted.includes('**') && !painted.includes('- [ ]') && !painted.includes('```'), 'no Markdown syntax is painted')
    assert.ok(painted.includes('Needs review'), 'the checklist reference shows its live status')

    await a.getByTestId('lab-focus-end').click()
    const before = await source()
    // Typing is one undo step; redo brings it back.
    await type(' Done.')
    await tail('paragraph. Done.\n')
    await editor.press('cmd-z'); await tail('paragraph.\n')
    await editor.press('cmd-shift-z'); await tail('paragraph. Done.\n')
    // Markdown shortcuts.
    await editor.press('enter'); await type('## Notes'); await tail('\n\n## Notes\n')
    // The slash menu: filter, choose with Enter.
    await editor.press('enter'); await type('/')
    await until(() => a.getByTestId('editor-slash-menu').count(), n => n === 1, 'slash menu opens')
    await type('che')
    await until(() => a.getByTestId('editor-slash-checklist').count(), n => n === 1, 'slash menu filters to Checklist')
    assert.equal(await a.getByTestId('editor-slash-h1').count(), 0)
    await a.screenshot({ path: path.join(out, `slash-${mode}.png`) })
    await editor.press('enter'); await type('Check'); await tail('\n\n- [ ] Check\n')
    assert.equal(await a.getByTestId('editor-slash-menu').count(), 0, 'slash menu closes')
    // Formatting is its own step: undo removes the bold, not the word.
    await editor.press('shift-alt-left'); await editor.press('cmd-b'); await tail('- [ ] **Check**\n')
    await editor.press('cmd-z'); await tail('- [ ] Check\n')
    // A click on the checkbox ticks the item.
    let layout = (await debug()).layout
    const item = layout.blocks.at(-1)!
    await a.mouse.click({ x: layout.x + item.listX + 8, y: layout.y + item.ty + item.lineHeight / 2 })
    await tail('- [x] Check\n')
    await a.screenshot({ path: path.join(out, `edited-${mode}.png`) })

    // Selection across blocks: delete, then undo restores the exact Markdown.
    const edited = await source()
    await editor.press('cmd-up'); await editor.press('shift-down'); await editor.press('shift-down'); await editor.press('backspace')
    await until(source, s => s !== edited && !s.startsWith('# Release checklist\n\nShip'), 'cross-block delete')
    await editor.press('cmd-z'); await until(source, s => s === edited, 'undo restores the document')

    // Rich paste keeps formatting; plain paste does not.
    await editor.press('cmd-up'); await editor.press('down'); await editor.press('shift-alt-right'); await editor.press('shift-alt-right'); await editor.press('shift-alt-right'); await editor.press('shift-alt-right')
    await editor.press('cmd-c'); await editor.press('cmd-down'); await editor.press('enter'); await editor.press('cmd-v')
    await until(source, s => (s.match(/\*\*native editor\*\*/g) ?? []).length === 2, 'rich paste keeps bold')
    await editor.press('cmd-z'); await until(source, s => (s.match(/\*\*native editor\*\*/g) ?? []).length === 1, 'undo paste')
    await editor.press('cmd-shift-v'); await until(source, s => /Ship the native editor\n?$/.test(s.trimEnd()) && (s.match(/\*\*native editor\*\*/g) ?? []).length === 1, 'plain paste drops formatting')

    // The live chip opens its task; ⌘-click opens a link, a plain click places the caret.
    layout = (await debug()).layout
    const chipBlock = layout.blocks.find(b => b.chips.length)!
    const chip = chipBlock.chips[0]!
    await a.mouse.click({ x: layout.x + chip[0]! + chip[2]! / 2, y: layout.y + chip[1]! + chip[3]! / 2 })
    await until(async () => JSON.parse(await text('editor-links')) as string[], l => l.includes('kybern://task/11111111-1111-4111-8111-111111111111'), 'chip click opens the task')
    const link = layout.blocks.find(b => b.links.length)!.links[0]!
    await a.mouse.click({ x: layout.x + link[0]! + 6, y: layout.y + link[1]! + link[3]! / 2 })
    await until(() => a.getByTestId('editor-link-bubble').count(), n => n === 1, 'caret inside a link shows the link bubble')
    await a.screenshot({ path: path.join(out, `link-${mode}.png`) })
    assert.equal((JSON.parse(await text('editor-links')) as string[]).length, 1, 'a plain click does not open the link')
    await a.mouse.click({ x: layout.x + link[0]! + 6, y: layout.y + link[1]! + link[3]! / 2 }, { modifiers: 'cmd' })
    await until(async () => JSON.parse(await text('editor-links')) as string[], l => l.includes('https://kybern.dev/docs'), '⌘-click opens the link')

    // Input method: marked text shows in place, the commit is one undo step.
    await a.getByTestId('lab-focus-end').click()
    const beforeEnter = await source()
    await editor.press('enter')
    const composedBase = await until(source, s => s !== beforeEnter, 'Enter before composing')
    for (const step of ['lab-ime-n', 'lab-ime-ni', 'lab-ime-nihon']) await a.getByTestId(step).click()
    assert.equal((await debug()).selection.composing, true, 'composing while marked')
    await until(async () => (await a.call('getPaintedText', {})).text.join('\n'), t => t.includes('日本'), 'marked text painted')
    await a.screenshot({ path: path.join(out, `ime-${mode}.png`) })
    await a.getByTestId('lab-ime-commit').click()
    await tail('日本\n')
    assert.equal((await debug()).selection.composing, false)
    await a.getByTestId('lab-focus-end').click(); await editor.press('cmd-z')
    await until(source, s => s === composedBase || s.trimEnd() === composedBase.trimEnd(), 'the composition is one undo step')

    // A keystroke reshapes one block, not the document.
    await a.getByTestId('lab-focus-end').click(); await a.getByTestId('lab-stats').click()
    await type('abcde'); await tail('abcde\n')
    await a.getByTestId('lab-stats').click()
    const stats = JSON.parse(await text('editor-result')) as { reshaped: number; blocks: number }
    assert.ok(stats.reshaped <= 7 && stats.blocks > 15, `reshaped ${stats.reshaped} blocks for 5 keys in a ${stats.blocks}-block document`)
    console.log(`ok ${mode}: painted formatting and live chip, typing step + redo, shortcuts, slash filter/choose, format step, checkbox click, cross-block delete/undo, rich/plain paste, chip and ⌘-click links, IME one step, ${stats.reshaped} reshapes for 5 keys in ${stats.blocks} blocks`)
    void before
  } catch (error) { console.error(f.diagnostics()); await a.screenshot({ path: path.join(out, `failure-${mode}.png`) }).catch(() => {}); throw error }
  finally { await f.close() }
}
