import { expect, test } from 'bun:test'
import { toolLine } from '../../../../packages/kybern-client/src/toolActivity.ts'

const bash = (command: string) => toolLine({ id: 'call', name: 'Bash', input: { command } } as Parameters<typeof toolLine>[0])

test('a cat here-doc into a file is a write, not a read of the marker', () => {
  expect(bash(`cat >> /tmp/notes.md <<'EOF'\nline\nEOF`)).toMatchObject({ kind: 'edit', detail: expect.stringContaining('notes.md') })
  expect(bash(`cd /repo && cat > out.txt << EOF\nx\nEOF`)).toMatchObject({ kind: 'edit', detail: expect.stringContaining('out.txt') })
})

test('reads ignore redirections and here-doc markers', () => {
  expect(bash('cat src/main.ts')).toMatchObject({ kind: 'read', detail: expect.stringContaining('main.ts') })
  expect(bash('cat src/main.ts 2>/dev/null')).toMatchObject({ kind: 'read', detail: expect.stringContaining('main.ts') })
  expect(bash('tail -5 log.txt > /dev/null')).toMatchObject({ kind: 'read', detail: expect.stringContaining('log.txt') })
})
