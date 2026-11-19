import { expect, mock, test } from 'bun:test'

// Settings writes are optimistic and queued (the scroll jump on click, #309's batch): the page shows a change at once, a
// second change made while the first saves is not dropped, and a failure goes back to what the daemon last confirmed.
type Doc = { generate_titles: boolean; worktrees_default: boolean; providers: Record<string, never> }
const sent: Doc[] = []
const answers: { resolve: (doc: Doc) => void; reject: (error: unknown) => void }[] = []
const client = {
  endpoint: { url: 'ws://127.0.0.1:1/ws', token: 'test' },
  call: (method: string, params: { settings: Doc }) => {
    if (method !== 'settings.update') return Promise.resolve({})
    sent.push(params.settings)
    return new Promise<Doc>((resolve, reject) => answers.push({ resolve, reject }))
  },
  onNotification: () => () => {},
}
const real = await import('../state.ts')
mock.module('../state.ts', () => ({ ...real, getClient: () => client, localClient: () => client }))
const { latestError, latestSettings, setSettings, updateSettings } = await import('./store.ts')
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const doc = () => latestSettings() as unknown as Doc

test('a change shows at once, and a second one made while the first saves is sent after it', async () => {
  setSettings({ generate_titles: true, worktrees_default: false, providers: {} } as never)
  const first = updateSettings({ generate_titles: false } as never)
  expect(doc()).toEqual({ generate_titles: false, worktrees_default: false, providers: {} })
  const second = updateSettings({ worktrees_default: true } as never)
  expect(doc()).toEqual({ generate_titles: false, worktrees_default: true, providers: {} })
  await tick()
  expect(sent).toHaveLength(1)
  // The first answer is older than what the page shows: the page keeps its newer document.
  answers[0]!.resolve({ ...sent[0]! })
  await first
  expect(doc()).toEqual({ generate_titles: false, worktrees_default: true, providers: {} })
  await tick()
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual({ generate_titles: false, worktrees_default: true, providers: {} })
  answers[1]!.resolve({ ...sent[1]! })
  await second
  expect(doc()).toEqual({ generate_titles: false, worktrees_default: true, providers: {} })
  expect(latestError()).toBeNull()
})

test('a failed save goes back to the confirmed document and reports the failure', async () => {
  sent.length = 0
  answers.length = 0
  setSettings({ generate_titles: true, worktrees_default: false, providers: {} } as never)
  const write = updateSettings({ generate_titles: false } as never)
  expect(doc().generate_titles).toBe(false)
  await tick()
  answers[0]!.reject(new Error('disk full'))
  await write
  expect(doc()).toEqual({ generate_titles: true, worktrees_default: false, providers: {} })
  expect(latestError()?.action).toBe('save the settings')
})
