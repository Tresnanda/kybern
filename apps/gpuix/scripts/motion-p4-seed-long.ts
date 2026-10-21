// Adds a long-list workload to a P4 scratch daemon: 280 more tasks and 240 more notes (on top of the visual fixture's 26 and 9), for the
// open-time and scroll comparisons in `motion-p4-bench.ts`.
//   VISUAL_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p4-long VISUAL_DAEMON_PORT=4374 bun visual/up.ts
//   VISUAL_SCRATCH=… VISUAL_DAEMON_PORT=4374 bun scripts/motion-p4-seed-long.ts
import { connect, readState } from '../visual/fixture.ts'

const state = readState()
if (!state) throw new Error('start the scratch daemon first (visual/up.ts)')
const client = await connect(state)
const projects = (await client.call('projects.list', {})).projects
const STATUS = ['inbox', 'todo', 'todo', 'todo', 'done', 'canceled'] as const
const words = ['sidebar', 'composer', 'transcript', 'dock', 'preview', 'terminal', 'settings', 'usage', 'worktree', 'daemon', 'mobile', 'palette']
for (let i = 0; i < 280; i++) {
  await client.call('tasks.items.create', { scope: 'project', project_id: projects[i % projects.length]!.id, title: `Long list task ${i + 1}: tighten the ${words[i % words.length]} ${words[(i * 5) % words.length]} path`, body: `Details for task ${i + 1}.\n\n- [ ] first check\n- [ ] second check`, status: STATUS[i % STATUS.length]!, priority: (i % 5) as 0 | 1 | 2 | 3 | 4 })
}
for (let i = 0; i < 240; i++) {
  const lines = Array.from({ length: 3 + (i % 9) }, (_, j) => `Line ${j + 1} of long list note ${i + 1}: ${words[(i + j) % words.length]} and ${words[(i * 3 + j) % words.length]}.`)
  await client.call('notes.create', { scope: 'project', project_id: projects[i % projects.length]!.id, title: `Long list note ${i + 1}`, body: `# Long list note ${i + 1}\n\n${lines.join('\n\n')}\n\n- [ ] follow up\n- [x] done` })
}
console.log('seeded: tasks', (await client.call('tasks.items.list', {})).tasks.length, 'notes', (await client.call('notes.list', {})).notes.length)
client.close?.()
process.exit(0)
