/**
 * Narrow composer (hands-on round 5, item 5): the footer's chips collapse by the footer's own width, like the desktop's
 * `@container` rules (Composer.tsx, ComposerModelTriggerLabel.tsx). Resizes by launching at each window size (900 is the narrowest the
 * app allows), both themes, reduced motion, with the dock closed and open. Captures the window and logs the painted footer text.
 *   bun scripts/hr5-polish-composer.ts [--widths 900,1000,1100,1280] [--dock] [--tag name]
 */
import assert from 'node:assert/strict'
import { launch, onTestDisplay, OUT } from './hr5-polish-lib.ts'
const arg = (n: string, d: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1]! : d)
const widths = arg('--widths', '900,1000,1100,1280').split(',').map(Number)
const dock = process.argv.includes('--dock')
const sidebar = Number(arg('--sidebar', '0')) || undefined
const tag = (dock ? 'dock' : '') + (sidebar ? `${dock ? '-' : ''}sb${sidebar}` : '')
for (const theme of ['dark', 'light'] as const) for (const width of widths) {
  const app = await launch({ theme, thread: 'Narrow composer', size: `${width}x${arg('--height', '820')}`, sidebar })
  try {
    await Bun.sleep(1800)
    if (dock) { await app.call('keystrokes' as never, { keys: 'cmd-j' } as never); await Bun.sleep(1200) }
    assert.ok(onTestDisplay(app.pid), 'window must be on the hidden test display')
    const footer = await app.getByTestId('composer-footer').bounds()
    await app.clock.fastForward(16)
    const label = `${theme}-${width}${tag ? '-' + tag : ''}`
    await app.screenshot({ path: `${OUT}/composer-gpuix-${label}.png` })
    const painted = String((await app.call('getPaintedText', {})).text)
    console.log(label, `footer ${Math.round(footer.width)}x${Math.round(footer.height)}`, JSON.stringify(painted.match(/Full access|Claude Opus 5\.5|High|Opus/g)))
  } finally { await app.closeAll() }
}
process.exit(0)
