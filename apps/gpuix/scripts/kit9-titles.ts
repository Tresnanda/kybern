// Scratch daemon helper: lists thread titles and (with --long) ensures a thread whose title is too long for the sidebar,
// plus a short one. Only the visual-pair scratch daemon is touched (the state file of this checkout's slot).
import { connect, readState } from '../visual/fixture.ts'
const state = readState()
if (!state) throw new Error('no scratch daemon: run `bun scripts/visual-pair.ts notes-gallery --keep`')
const client = await connect(state)
const { threads } = await client.call('threads.list', {})
if (process.argv.includes('--long') && !threads.some((t: any) => t.title.startsWith('A very long thread title'))) {
  const projects = (await client.call('projects.list', {})).projects
  const thread = await client.call('threads.create', { project_id: projects[0]!.id, title: 'A very long thread title that cannot possibly fit in the sidebar, so it pans on hover', provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
  console.log('created', thread.id)
}
for (const t of (await client.call('threads.list', {})).threads) console.log(t.id, JSON.stringify(t.title))
process.exit(0)
