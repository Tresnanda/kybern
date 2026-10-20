import { expect, test } from 'bun:test'
import { commandSummary, queuedPreview, trayDefaultOpen, traySummary, type TrayCounts } from '../../../../packages/kybern-client/src/composerTray.ts'

const none: TrayCounts = { subagents: { working: 0, done: 0, failed: 0, stopped: 0 }, tasks: 0, helpers: { total: 0, working: 0, approval: 0 }, queued: 0 }

test('a queued prompt shows its words, collapsed to one line', () => {
  expect(queuedPreview({ parts: [{ type: 'text', text: 'Also cover\n\nnull input.' }] })).toMatchObject({ text: 'Also cover null input.', kind: 'prompt', detail: null })
})

// The "Queued follow-up" placeholder came from reading only `text` parts: these messages have none.
test('an image-only follow-up reads as an image with its thumbnail, not a placeholder', () => {
  const preview = queuedPreview({ parts: [{ type: 'image', media_type: 'image/png', data: 'AAAA' }] })
  expect(preview).toMatchObject({ text: 'Image', imageCount: 1, imagesOnly: true, images: ['data:image/png;base64,AAAA'] })
  const two = queuedPreview({ parts: [{ type: 'image', media_type: 'image/png', data: 'AAAA' }, { type: 'attachment', asset_id: 'a', name: 'b.jpg', media_type: 'image/jpeg', size: 1 }] })
  expect(two.text).toBe('2 images')
  expect(two.imageCount).toBe(2)
})

test('delegated results and thread messages read from their parts', () => {
  const results = queuedPreview({ parts: [{ type: 'agent_results', items: [{ title: 'Audit the dock tabs', status: 'completed' }, { title: 'Profile the sidebar', status: 'completed' }] } as never] })
  expect(results).toMatchObject({ text: 'Results from 2 agents', detail: 'Audit the dock tabs, Profile the sidebar', kind: 'update' })
  const inbound = queuedPreview({ parts: [{ type: 'thread_message', from_thread_id: 't', from_title: 'Review sign-in', purpose: 'question', body: 'Should I add\nmore coverage?' } as never] })
  expect(inbound).toMatchObject({ text: 'Question from Review sign-in', detail: 'Should I add', kind: 'update' })
})

test('a prompt of only skills, mentions or files names them', () => {
  expect(queuedPreview({ parts: [{ type: 'skill', name: 'review', path: '/s' }, { type: 'file_mention', path: 'src/a.ts' }] }).text).toBe('$review @src/a.ts')
  expect(queuedPreview({ parts: [] }).text).toBe('Queued follow-up')
})

test('a command loses its cd prefix and keeps the folder', () => {
  expect(commandSummary('cd /Users/me/projects/ade-motion-fps/apps/gpuix && MOTION_SHOTS=1 bun scripts/x.ts')).toEqual({ text: 'MOTION_SHOTS=1 bun scripts/x.ts', folder: 'gpuix' })
  expect(commandSummary('cd "/tmp/with space/" ; cd sub && make')).toEqual({ text: 'make', folder: 'sub' })
  expect(commandSummary('bun test')).toEqual({ text: 'bun test', folder: null })
})

test('the summary leads with subagents, adds failures, tasks and the queue', () => {
  const counts = { ...none, subagents: { working: 1, done: 2, failed: 1, stopped: 0 }, tasks: 1, queued: 3 }
  expect(traySummary(counts).map(s => [s.text, s.tone])).toEqual([['1 of 4 subagents working', 'lead'], ['1 failed', 'failed'], ['1 background task', 'plain'], ['3 queued', 'plain']])
  expect(traySummary({ ...none, queued: 2 }).map(s => [s.text, s.tone])).toEqual([['2 queued', 'lead']])
  expect(traySummary({ ...none, subagents: { working: 0, done: 2, failed: 0, stopped: 0 } })[0]!.text).toBe('2 subagents finished')
})

test('the tray starts open for short lists and closed once many work or all settled', () => {
  expect(trayDefaultOpen({ ...none, subagents: { working: 2, done: 1, failed: 0, stopped: 0 } }, 3)).toBe(true)
  expect(trayDefaultOpen({ ...none, subagents: { working: 4, done: 0, failed: 0, stopped: 0 } }, 4)).toBe(false)
  expect(trayDefaultOpen({ ...none, subagents: { working: 0, done: 2, failed: 0, stopped: 0 } }, 2)).toBe(false)
  expect(trayDefaultOpen({ ...none, subagents: { working: 0, done: 1, failed: 1, stopped: 0 } }, 2)).toBe(true)
  expect(trayDefaultOpen({ ...none, subagents: { working: 0, done: 2, failed: 0, stopped: 0 }, queued: 1 }, 3)).toBe(true)
  expect(trayDefaultOpen({ ...none, queued: 9 }, 9)).toBe(false)
})
