import assert from 'node:assert/strict'
import type { launch } from '@gpuix/react/automation'
import type { pagesFixture } from './pages-fixture.ts'

type App = Awaited<ReturnType<typeof launch>>
type Fixture = ReturnType<typeof pagesFixture>

/** Capturing a native frame can delay input/RPC delivery beyond 700 ms. Send
 * Enter once, then observe completion; retrying input would hide duplicate work. */
export async function verifyPrRecovery(app: App, fixture: Fixture, kind: 'missing' | 'auth') {
  const count = () => fixture.calls.filter(method => method === 'github.pr.list').length
  const before = count()
  fixture.problem(kind)
  await app.getByTestId('pr-refresh').press('enter')
  const deadline = Date.now() + 10_000
  while (count() === before && Date.now() < deadline) await Bun.sleep(25)
  assert.equal(count(), before + 1, `One Enter must issue one PR refresh for ${kind}`)
  const expected = kind === 'missing' ? /Install the GitHub CLI/ : /Sign in to the GitHub CLI/
  let text = ''
  do {
    text = await app.getByTestId('page-pulls').textContent()
    if (expected.test(text)) break
    await Bun.sleep(25)
  } while (Date.now() < deadline)
  assert.match(text, expected)
  assert.equal(await app.getByTestId('pr-row-108').count(), 0, 'Recovery replaces the stale PR list')
}
