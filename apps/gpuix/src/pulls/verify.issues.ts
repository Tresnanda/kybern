/**
 * #217 Issues tab: the list with its Open / Closed, search, Labels and Assignee filters and "Show more", an issue with its
 * description, comments and sidebar, "Start a thread", and the filter toolbars of Pull requests, Actions and Issues sharing one
 * control height and centre line. Images in an issue (GitHub's HTML `<img>`, Markdown, one GitHub didn't share) and the
 * comment box: ⌘↩ / Ctrl+Enter posts, the comment shows at once, the draft stays with its issue, a signed-out gh disables the
 * box with the fix. Mock RPC only: nothing reaches GitHub. `--light` for the light theme;
 * `KYBERN_VERIFY_OUTPUT=<dir>` saves screenshots.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT
if (out) mkdirSync(out, { recursive: true })
const fixture = actionFixture({ checkLinks: true })
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { KYBERN_WINDOW_SIZE: '1280x820', ...fixture.env, KYBERN_APPEARANCE: mode })
const a = f.app
const shot = async (name: string) => { if (out) await a.screenshot({ path: `${out}/${name}-${mode}.png` }) }
/** A retained row can exist before paint, or move while the list finishes measuring. */
const paintedBounds = async (id: string) => {
  const end = Date.now() + 10000
  let previous = ''
  while (Date.now() < end) {
    try {
      const box = await a.getByTestId(id).bounds()
      const key = JSON.stringify(box)
      if (box.width > 0 && box.height > 0 && key === previous) return box
      previous = key
    } catch { previous = '' }
    await Bun.sleep(100)
  }
  assert.fail(`no stable painted bounds for ${id}`)
}
const click = async (id: string) => {
  try { await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await paintedBounds(id); await a.getByTestId(id).click() }
  catch (e) { throw new Error(`click ${id}: ${e}`) }
  await Bun.sleep(450)
}
const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
const until = async (re: RegExp) => { const end = Date.now() + 10000; while (Date.now() < end) { if (re.test(await painted())) return; await Bun.sleep(200) } assert.fail(`never painted ${re}\n${(await painted()).slice(0, 3000)}`) }
const waitFor = async (id: string, timeoutMs: number) => { try { await a.getByTestId(id).waitFor({ timeoutMs }) } catch (e) { throw new Error(`waitFor ${id}: ${e}`) } }
const exists = async (id: string) => { try { await a.getByTestId(id).waitFor({ timeoutMs: 3000 }); return true } catch { return false } }
const send = process.platform === 'darwin' ? 'cmd-enter' : 'ctrl-enter'
const count = (id: string) => a.getByTestId(id).count()
/** The issue's end: rows measure as they mount, so wheel again until it settles. */
const toEnd = async () => { for (let i = 0; i < 3; i++) { await a.getByTestId('issue-scroll').wheel(0, -100000); await Bun.sleep(400) } }
const listCalls = () => fixture.params.filter(p => p.method === 'github.issue.list').map(p => p.params)
const lastList = () => listCalls().at(-1)!
/** Every control of a toolbar row is 24 high and centred on the same line. */
async function level(ids: string[], label: string) {
  const boxes = await Promise.all(ids.map(id => a.getByTestId(id).bounds()))
  const centre = (b: { y: number; height: number }) => b.y + b.height / 2
  for (const [i, b] of boxes.entries()) {
    assert.ok(Math.abs(b.height - 24) <= 0.5, `${label}: ${ids[i]} is 24 high, not ${b.height}`)
    assert.ok(Math.abs(centre(b) - centre(boxes[0]!)) <= 0.5, `${label}: ${ids[i]} is centred on the row (${centre(b)} vs ${centre(boxes[0]!)})`)
  }
}
try {
  await waitFor('app-ready', 60000)
  await click('rail-pulls')

  // The toolbars of Pull requests and Actions share one height.
  await waitFor('pr-row-108', 10000)
  await level(['pr-filter', 'pr-search'], 'Pull requests')
  await shot('toolbar-pulls')
  await click('pulls-tab-actions')
  await waitFor('actions-branch', 10000)
  await level(['actions-workflow-chip', 'actions-branch'], 'Actions')
  await shot('toolbar-actions')

  // The Issues tab: the first page, open issues, newest first.
  await click('pulls-tab-issues')
  await waitFor('issue-row-249', 10000)
  await until(/Model picker: vertical harness rail/)
  await level(['issues-state', 'issues-search'], 'Issues')
  await level(['issues-labels-chip', 'issues-assignee-chip'], 'Issues filters')
  assert.deepEqual({ state: lastList().state, limit: lastList().limit, offset: lastList().offset }, { state: 'open', limit: 30, offset: 0 })
  assert.ok(await exists('issue-linked-246'), 'a pull request that closes an issue marks its row')
  await shot('toolbar-issues')
  await shot('issues-list')

  // Select an issue: heading, state, description, comments and sidebar.
  await click('issue-row-217')
  await waitFor('issue-detail', 10000)
  await until(/Done when/)
  await until(/Could the list keep the same keyboard shortcuts/)
  const detail = await painted()
  for (const text of ['#217', 'Open', 'Start a thread', 'opened this', 'Assignees', 'Labels', 'Milestone', '0.22.0', 'Pull requests', '#250 GitHub issues page', '#226 Plain errors for gh', 'Commenting and closing come in a later release']) assert.ok(detail.includes(text), `the issue shows ${text}`)
  assert.doesNotMatch(detail, /Select an issue/)
  assert.ok(fixture.params.some(p => p.method === 'github.issue.detail' && p.params.number === 217))
  await Bun.sleep(500)
  await shot('issues-detail')

  // Images: GitHub's own `<img>` and a Markdown image in the description, one in a comment, all through the project's
  // machine (`/github/image`); the one GitHub didn't share shows its caption and why, never its HTML.
  await click('issue-row-228')
  await until(/Pairing stops at the second step/)
  { const end = Date.now() + 15000; while (Date.now() < end && (await count('response-image')) < 3) await Bun.sleep(250) }
  assert.equal(await count('response-image'), 3, 'two images in the description and one in the comment')
  await waitFor('github-image-failed', 10000)
  const pictured = await painted()
  assert.ok(pictured.includes("The daemon's log"), 'the text between the images shows')
  assert.doesNotMatch(pictured, /<img|user-attachments|!\[/, 'no image is painted as HTML or Markdown')
  const fetched = fixture.params.filter(p => p.method === 'GET /github/image').map(p => p.params as Record<string, string>)
  assert.ok(fetched.some(p => p.number === '228' && p.project_id === 'pages-fixture' && p.url.includes('/user-attachments/assets/')), 'images load through the project\'s machine')
  const widths = (await a.getByTestId('response-image').all()).map(node => node.bounds?.width ?? 0)
  assert.ok(widths.some(w => w > 280) && widths.every(w => w <= 480.5), `issue images are drawn larger than a reply's, at most 480 wide (${widths})`)
  await shot('issue-images')
  await a.getByTestId('issue-scroll').wheel(0, -700); await Bun.sleep(500)
  const below = await painted()
  for (const text of ['Phone settings', "GitHub didn't share this image"]) assert.ok(below.includes(text), `the issue shows ${text}`)
  assert.doesNotMatch(below, /<img|user-attachments|!\[/, 'no image is painted as HTML or Markdown')
  await shot('issue-images-comments')
  await toEnd()
  assert.match(await painted(), /Same on Android 15/)

  // The comment box: ⌘↩ / Ctrl+Enter posts, and the comment is in the timeline before GitHub answers (600 ms in the fixture).
  await a.getByTestId('issue-comment-input').waitFor({ timeoutMs: 10000 })
  await toEnd()
  await a.getByTestId('issue-comment-input').click()
  await a.getByTestId('issue-comment-input').fill('Fixed by **#250**: the pairing step now retries over Tailscale.')
  await Bun.sleep(300)
  await shot('issue-comment-box')
  await a.getByTestId('issue-comment-input').press(send)
  await Bun.sleep(250)
  // Before GitHub answers: the comment is in the timeline as yours, rendered (no `**`), and the box is empty.
  const pending = await painted()
  assert.ok(fixture.params.some(p => p.method === 'github.issue.comment'), `${send} posts the comment`)
  assert.match(pending, /You[\s\S]*Fixed by #250: the pairing step/, 'the comment shows before GitHub answers, as yours')
  assert.equal(await count('issue-comment-input-placeholder'), 1, 'the box is empty while it posts')
  await shot('issue-comment-pending')
  await Bun.sleep(900)
  const posted = fixture.params.filter(p => p.method === 'github.issue.comment').map(p => p.params as { number: number; body: string; project_id: string })
  assert.deepEqual(posted, [{ project_id: 'pages-fixture', number: 228, body: 'Fixed by **#250**: the pairing step now retries over Tailscale.' }])
  await until(/tresnanda[\s\S]*Fixed by/)
  assert.equal(await a.getByTestId('pr-timeline-IC_posted_1').count(), 1, "GitHub's copy replaced the pending one")
  assert.equal(await count('issue-comment-input-placeholder'), 1, 'the box is empty again')

  // The draft stays with its issue: typed on #228, gone on #217, back on #228; the Comment button posts too.
  await a.getByTestId('issue-comment-input').fill('Draft for 228')
  await Bun.sleep(300)
  await click('issue-row-217')
  await until(/Done when/)
  assert.doesNotMatch(await painted(), /Draft for 228/)
  await click('issue-row-228')
  await toEnd()
  await until(/Draft for 228/)
  await click('issue-comment-send')
  await Bun.sleep(900)
  assert.equal(fixture.params.filter(p => p.method === 'github.issue.comment').length, 2, 'the Comment button posts')

  // A signed-out gh: the comment goes back in the box, which waits behind the fix.
  await a.getByTestId('issue-comment-input').fill('Ping #signed-out')
  await a.getByTestId('issue-comment-input').press(send)
  await waitFor('issue-comment-problem', 10000)
  await until(/Sign in to GitHub/)
  assert.match(await painted(), /Ping #signed-out/, 'the words are back in the box')
  await shot('issue-comment-signed-out')

  // Closed, search, labels, assignee: each asks GitHub, nothing is filtered on the client.
  await click('issues-state-closed')
  await waitFor('issue-row-213', 10000)
  assert.equal(lastList().state, 'closed')
  assert.ok(!(await exists('issue-row-249')), 'open issues are gone from the Closed list')
  await click('issues-state-open')
  await waitFor('issue-row-249', 10000)
  await a.getByTestId('issues-search').fill('Terminal'); await Bun.sleep(900)
  assert.equal(lastList().search, 'Terminal')
  await waitFor('issue-row-241', 10000)
  assert.ok(!(await exists('issue-row-249')), 'search narrows the list')
  await a.getByTestId('issues-search').fill(''); await Bun.sleep(900)
  await click('issues-labels-chip')
  await click('issues-label-bug')
  await a.getByTestId('issues-label-bug').press('escape'); await Bun.sleep(400)
  assert.deepEqual(lastList().labels, ['bug'])
  await click('issues-assignee-chip')
  await click('issues-assignee-me')
  await Bun.sleep(600)
  assert.equal(lastList().assignee, '@me')
  assert.ok(!(await exists('issue-row-241')), 'only my issues')
  await shot('issues-filtered')

  // A long list shows more on request.
  await click('issues-assignee-chip'); await click('issues-assignee-anyone')
  await click('issues-labels-chip'); await click('issues-labels-clear'); await Bun.sleep(600)
  assert.equal(lastList().assignee, undefined)
  assert.equal(lastList().labels, undefined)
  await a.getByTestId('issues-list').wheel(0, -100000); await Bun.sleep(500)
  await waitFor('issues-more', 10000)
  await paintedBounds('issues-more')
  await click('issues-more')
  await Bun.sleep(500)
  assert.equal(lastList().offset, 30)

  // Start a thread: a new thread in the project whose first message is the issue.
  await a.getByTestId('issues-list').wheel(0, 100000); await Bun.sleep(500)
  await waitFor('issue-row-217', 10000)
  await click('issue-row-217')
  await waitFor('issue-start-thread', 10000)
  await until(/GitHub: list and open a repository’s issues/)
  assert.equal(fixture.params.filter(p => p.method === 'github.issue.detail').at(-1)?.params.number, 217, 'selected issue is #217 before starting a thread')
  await click('issue-start-thread')
  await Bun.sleep(800)
  const created = fixture.params.find(p => p.method === 'threads.create')?.params as { project_id: string; title: string; message: { parts: { text: string }[] } } | undefined
  assert.ok(created, 'a thread was created')
  assert.equal(created.project_id, 'pages-fixture')
  assert.equal(created.title, '#217 GitHub: list and open a repository’s issues')
  const text = created.message.parts[0]!.text
  for (const part of ['Issue #217', 'https://github.com/acme/api/issues/217', 'list and open a repository’s issues', 'Done when', 'arifw', 'Commenting and closing come in a later release']) assert.ok(text.includes(part), `the first message has ${part}`)
  console.log(`[issues] ${mode} ok`)
} finally {
  await f.close()
  fixture.close()
}
