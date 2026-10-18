import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { assertScratchEnv } from '../../src/requests/harness.ts'

assertScratchEnv({ KYBERN_URL: '' })
const data = process.env.KYBERN_DATA_DIR!
const root = path.join(data, 'project')
mkdirSync(root, { recursive: true })
for (let n = 0; n < 2200; n++) writeFileSync(path.join(root, `file-${String(n).padStart(4, '0')}.ts`), `export const file${n} = ${n}\n`)
for (let n = 0; n < 30; n++) {
  const folder = path.join(root, `folder-${String(n).padStart(2, '0')}`, 'deep', 'nested')
  mkdirSync(folder, { recursive: true })
  for (let k = 0; k < 40; k++) writeFileSync(path.join(folder, `module-${k}.ts`), `export const item = ${k}\n`)
}
const block = (n: number) => [`## Section ${n}`, '', 'A long document with **bold**, _emphasis_, [links](https://example.com), and inline `code`.', '', '- First item', '- Second item', '  - Nested item', '', '```typescript', `export const item${n} = { count: ${n}, label: "preview" };`, '```', '', '| Name | Count |', '| --- | ---: |', `| Row ${n} | ${n} |`, '', '![Local image](image.svg)', '', '> A quote with wrapping text that exercises the native Markdown layout.', ''].join('\n')
writeFileSync(path.join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"><rect width="160" height="40" fill="#6495ed"/></svg>')
writeFileSync(path.join(root, 'long.md'), '# Long preview\n\n' + Array.from({ length: 150 }, (_, i) => block(i)).join('\n'))
writeFileSync(path.join(root, 'preview.md'), '# Rendered preview\n\n' + Array.from({ length: 60 }, (_, i) => block(i)).join('\n'))
writeFileSync(path.join(root, 'long.ts'), Array.from({ length: 5000 }, (_, i) => `export const item${i} = { index: ${i}, text: "row ${i}" };`).join('\n'))
writeFileSync(path.join(root, 'minified.ts'), `export const items = [${Array.from({ length: 8000 }, (_, i) => `"item${i}"`).join(',')}];`)
writeFileSync(path.join(root, 'large.json'), JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `Item ${i}`, enabled: true })), null, 2))
writeFileSync(path.join(root, 'dock-example.ts'), 'export const example = 1;\nexport const next = 2;\n')
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect()
while (client.status !== 'open') await Bun.sleep(25)
try {
  const project = (await client.call('projects.list', {})).projects.find(p => p.path === root) ?? await client.call('projects.add', { path: root, name: 'Explorer performance' })
  const thread = (await client.call('threads.list', {})).threads.find(t => t.project_id === project.id) ?? await client.call('threads.create', { project_id: project.id, title: 'Explorer performance', provider: { kind: 'claude-code', instance: 'default' } })
  writeFileSync(path.join(data, 'fixture.json'), JSON.stringify({ projectId: project.id, threadId: thread.id, root }))
  console.log(JSON.stringify({ projectId: project.id, threadId: thread.id, files: 3407, rootEntries: 2237, deepDirectories: 90, root }))
} finally { client.close() }
