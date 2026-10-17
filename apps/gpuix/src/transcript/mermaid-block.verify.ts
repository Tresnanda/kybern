// A settled mermaid fence in a real thread: the diagram renders as an image with the Preview/Source
// switch and an expand dialog; an invalid diagram stays source with the desktop's note.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { EVIDENCE, launchLive, until } from './live.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? `${EVIDENCE}/mermaid-block`
mkdirSync(out, { recursive: true })
for (const theme of ['dark', 'light'] as const) for (const reduced of [false, true]) {
  const tag = `${theme}${reduced ? '-reduced' : ''}`
  const f = await launchLive({ theme, reduced, thread: 'Mermaid diagram' })
  try {
    const app = f.app, count = (id: string) => app.getByTestId(id).count()
    await until(async () => (await count('diagram-image')) > 0, 'diagram image', 30000)
    await app.screenshot({ path: `${out}/preview-${tag}.png` })
    assert.equal(await count('diagram-note'), 0, 'no failure note')
    await app.getByTestId('diagram-source').click(); await Bun.sleep(400)
    await until(async () => (await count('diagram-image')) === 0 && (await count('code-body')) > 0, 'source view')
    await app.screenshot({ path: `${out}/source-${tag}.png` })
    await app.getByTestId('diagram-preview').click(); await Bun.sleep(400)
    await until(async () => (await count('diagram-image')) > 0, 'preview again')
    await app.getByTestId('diagram-expand').click(); await Bun.sleep(500)
    await until(async () => (await count('diagram-expanded')) > 0, 'expanded')
    await app.screenshot({ path: `${out}/expanded-${tag}.png` })
    await app.getByTestId('app-ready').press('escape'); await Bun.sleep(300)
    await until(async () => (await count('diagram-expanded')) === 0, 'expanded closed')
    console.log(`PASS ${tag}: diagram, Source/Preview switch, expand and close`)
  } catch (error) { console.log(f.diagnostics()); throw error } finally { await f.close() }
  const g = await launchLive({ theme, reduced, thread: 'Mermaid invalid' })
  try {
    await until(async () => (await g.app.getByTestId('diagram-note').count()) > 0, 'failure note', 30000)
    assert.equal(await g.app.getByTestId('diagram-image').count(), 0)
    await g.app.screenshot({ path: `${out}/invalid-${tag}.png` })
    console.log(`PASS ${tag}: invalid diagram stays source with a note`)
  } finally { await g.close() }
}
process.exit(0)
