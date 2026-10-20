import { test, expect } from 'bun:test'
test('Explorer preview handoff is consumed once and rejects stale environment/thread/workspace', async () => {
  const child = Bun.spawn(['bun', `${import.meta.dir}/explorerSelection.verify.ts`], { stdout: 'pipe', stderr: 'pipe' })
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited, stderr).toBe(0)
})
