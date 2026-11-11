// `diff` fences (#294) on screen, dark and light: the lab is launched against a scratch data directory, painted, and the
// fence's removed, added and hunk-header lines are checked for their tint and colour by sampling the window. Writes
// `diff-fence-{dark,light}.png` to KYBERN_VERIFY_OUTPUT.
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../src/requests/harness.ts'
import { pngPixels } from './check-harness.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build')
mkdirSync(out, { recursive: true })

for (const mode of ['dark', 'light'] as const) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-diff-fence-'))
  const f = await launchFixture(path.join(import.meta.dir, 'diff-fence-lab.tsx'), { KYBERN_APPEARANCE: mode, GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '' })
  try {
    const a = f.app
    await a.getByTestId('app-ready').waitFor()
    await Bun.sleep(1000)
    const file = path.join(out, `diff-fence-${mode}.png`)
    await a.screenshot({ path: file })
    const png = pngPixels(file)
    // A run's element is full width: its middle is the tint, not the page.
    const probe = async (testId: string, which: number) => {
      const nodes = (await a.getByType('div').all()).filter(node => node.testId === testId && node.bounds).sort((x, y) => x.bounds!.y - y.bounds!.y)
      const bounds = nodes[which]!.bounds!
      const scale = png.width / 620
      return png.at(Math.floor((bounds.x + bounds.width - 6) * scale), Math.floor((bounds.y + bounds.height / 2) * scale))
    }
    const [del, add, plain] = [await probe('diff-del', 0), await probe('diff-add', 0), await probe('diff-plain', 0)]
    assert.ok(del[0]! > del[1]! + 6, `removed lines tint toward red: ${del}`)
    assert.ok(add[1]! > add[0]! + 6, `added lines tint toward green: ${add}`)
    assert.ok(Math.abs(plain[0]! - plain[1]!) < 6, `context stays neutral: ${plain}`)
    console.log(`captured ${mode}`, { del, add, plain })
  } catch (e) { console.error(f.diagnostics()); throw e }
  finally { await f.close() }
}
