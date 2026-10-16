import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { connect } from '../visual/fixture.ts'
const data = '/Users/mymac/projects/ade-gpuix-scratch/round7-dock'
mkdirSync(data, { recursive: true })
if (!existsSync(path.join(data, 'daemon.token'))) {
  const daemon = spawn('/Applications/kybern.app/Contents/MacOS/kybernd', ['--data-dir', data, '--port', '4273'], { detached: true, stdio: 'ignore' })
  daemon.unref(); writeFileSync(path.join(data, 'dock7-daemon.pid'), String(daemon.pid))
}
const deadline = Date.now() + 15000
while (!existsSync(path.join(data, 'daemon.port'))) { if (Date.now() > deadline) throw Error('Scratch daemon did not start'); await Bun.sleep(25) }
if (readFileSync(path.join(data, 'daemon.port'), 'utf8').trim() !== '4273') throw Error('Scratch port mismatch')
const visual = path.join(data, 'visual')
mkdirSync(path.join(visual, 'data'), { recursive: true })
for (const file of ['daemon.token', 'daemon.port']) copyFileSync(path.join(data, file), path.join(visual, 'data', file))
let previousVisual: Record<string, unknown> = {}
try { previousVisual = JSON.parse(readFileSync(path.join(visual, 'state.json'), 'utf8')) } catch { /* First run. */ }
writeFileSync(path.join(visual, 'state.json'), JSON.stringify({ ...previousVisual, daemonPid: Number(readFileSync(path.join(data, 'dock7-daemon.pid'), 'utf8')), port: 4273, daemonPort: 4273, proxyPid: undefined, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim(), seeded: true }))
const projectPath = path.join(data, 'project')
for (const dir of ['src/components/kit', 'docs/guides', 'tests', 'large']) mkdirSync(path.join(projectPath, dir), { recursive: true })
for (const file of ['README.md', 'src/App.tsx', 'src/main.tsx', 'src/components/Button.tsx', 'src/components/Input.tsx', 'src/components/kit/index.ts', 'src/components/kit/theme.ts', 'docs/README.md', 'docs/guides/setup.md', 'tests/tree.test.ts']) writeFileSync(path.join(projectPath, file), `// ${file}\nexport const example = true;\n`)
for (let i = 0; i < 400; i++) writeFileSync(path.join(projectPath, `large/file-${String(i).padStart(3, '0')}.ts`), `export const value = ${i};\n`)
if (!existsSync(path.join(projectPath, '.git'))) execFileSync('git', ['init', '-q', projectPath])
const client = await connect({ daemonPid: 0, port: 4273, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim(), seeded: true })
try {
  const projects = (await client.call('projects.list', {})).projects
  const project = projects.find(p => p.path === projectPath) ?? await client.call('projects.add', { path: projectPath, name: 'Dock7 nested project' })
  let threads = (await client.call('threads.list', {})).threads
  for (const kind of ['claude-code', 'codex', 'opencode', 'pi', 'omp', 'cursor'] as const) {
    if (!threads.some(t => t.title === `Dock7 ${kind}`)) await client.call('threads.create', { project_id: project.id, title: `Dock7 ${kind}`, provider: { kind, instance: 'default' } })
  }
  threads = (await client.call('threads.list', {})).threads
  writeFileSync(path.join(data, 'dock7-fixture.json'), JSON.stringify({ project: project.id, thread: threads.find(t => t.title === 'Dock7 claude-code')!.id, projectPath }))
  console.log('Seeded nested tree and six settled provider threads')
} finally { client.close() }
