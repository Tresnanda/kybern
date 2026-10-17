/** Scratch daemon only. Never starts an agent turn or touches the user's daemon. */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-shell-'))
const data = path.join(scratch, 'data'), projectPath = path.join(scratch, 'project')
mkdirSync(data); mkdirSync(projectPath)
execFileSync('git', ['init', projectPath], { stdio: 'ignore' })
writeFileSync(path.join(projectPath, 'README.md'), '# Scratch shell fixture\n')
execFileSync('git', ['-C', projectPath, 'add', 'README.md'])
execFileSync('git', ['-C', projectPath, 'commit', '-m', 'Fixture'], { stdio: 'ignore' })
const daemon = spawn('/Applications/kybern.app/Contents/MacOS/kybernd', ['--data-dir', data, '--port', '0'], { stdio: 'ignore' })
let client: KybernClient | undefined
let child: ReturnType<typeof Bun.spawn> | undefined
try {
  const deadline = Date.now() + 30000
  while (!existsSync(path.join(data, 'daemon.port'))) { if (Date.now() > deadline || daemon.exitCode !== null) throw Error('Scratch daemon failed'); await Bun.sleep(30) }
  client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
  client.connect()
  while (client.status !== 'open') { if (Date.now() > deadline) throw Error('Connection failed'); await Bun.sleep(30) }
  const project = await client.call('projects.add', { path: projectPath, name: 'Shell fixture' })
  const thread = await client.call('threads.create', { project_id: project.id, title: 'Shell verification', use_worktree: true, provider: { kind: 'claude-code', instance: 'default' } })
  console.log('Scratch thread created; no agent turn. Checkpoints:', (await client.call('threads.checkpoints', { thread_id: thread.id })).checkpoints.length)
  child = Bun.spawn(process.argv.slice(2), { env: { ...process.env, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(scratch, 'credentials'), KYBERN_GPUIX_THREAD: thread.id, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '' }, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
  process.exitCode = await child.exited
} finally {
  child?.kill(); client?.close(); daemon.kill()
  await new Promise<void>((resolve) => { if (daemon.exitCode !== null) resolve(); else daemon.once('exit', () => resolve()) })
  rmSync(scratch, { recursive: true, force: true })
  const key = createHash('sha1').update(data).digest('hex').slice(0, 12)
  for (const kind of ['workspace', 'appearance']) rmSync(path.join(homedir(), 'Library/Application Support/kybern-gpuix', `${kind}-${key}.json`), { force: true })
}
