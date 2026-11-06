import { test, expect } from 'bun:test'
test('file actions use the thread machine, preserve binary bytes and reuse unchanged downloads', async () => {
  const child = Bun.spawn(['bun', `${import.meta.dir}/threadFiles.verify.ts`], { stdout: 'pipe', stderr: 'pipe' })
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
})
