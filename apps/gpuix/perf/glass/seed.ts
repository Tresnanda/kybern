/**
 * Scratch daemon + one thread for the round-2 glass captures (`src/platform/verify.glass.ts`, `perf/glass/app.ts`).
 *
 * The thread holds, top to bottom: two filler turns, a turn whose prompt is an inbound message ("Message from …") long
 * enough to clamp and whose edits leave an "Edited 3 files" card (a real git checkpoint, so `threads.diff` answers from
 * the daemon), and a last turn tall enough that scrolling 600 px up leaves both cards in view with the scroll pill shown.
 * All lines are short, so the right half of the column stays empty for the sample points.
 *
 * Same technique as `perf/bench/seed.ts`: RPC creates the project and threads, SQL appends synthetic provider events and the
 * checkpoint row (no import RPC exists). No agent runs: the daemon gets `HOME=<scratch>/home PATH=/usr/bin:/bin` only
 * (`env -i` semantics), so no agent CLI can be found. The data dir must contain `gpuix-scratch`; nothing touches `~/.kybern`.
 *
 *   KYBERN_DATA_DIR=<…/gpuix-scratch-glass/data> bun perf/glass/seed.ts      # seed, print the manifest, stop the daemon
 */
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assertScratchEnv } from '../../src/requests/harness.ts'
import { connect, freePort } from '../../visual/fixture.ts'

export const DAEMON = process.env.KYBERN_TEST_DAEMON ?? '/Applications/kybern.app/Contents/MacOS/kybernd'
const OWNER_KIND = 'gpuix-glass-v1'

export interface GlassManifest { thread: string; sender: string; project: string; projectPath: string; editTurn: string; files: string[]; expandFile: string }
export interface GlassFixture {
  data: string
  /** Sibling scratch folder for the daemon's HOME, the git project and per-launch client config dirs. */
  extras: string
  manifest: GlassManifest
  /** What a GPUIX launch needs to reach this daemon (explicit endpoint: the app never manages it). */
  env: Record<string, string>
  close: () => Promise<void>
}

const uuid = (key: string) => { const h = createHash('sha256').update(`glass-v1:${key}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}` }

// ─── Content ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `KYBERN_GLASS_WIDE=1` (the blur checker, `src/platform/verify.blur.ts`): lines that run across the column, so a frosted popup has text to blur. */
const WIDE = process.env.KYBERN_GLASS_WIDE === '1'
const shortList = (label: string, n: number) => Array.from({ length: n }, (_, i) => WIDE ? `- ${label} ${i + 1} keeps the whole line busy, so a frosted surface over it has real detail to blur out, word after word.` : `- ${label} ${i + 1} stays short.`).join('\n')
export const FILLER = (i: number) => `## Pass ${i + 1}\n\nThe layout holds.\n\n${shortList('Check', 10)}\n\nNothing else moved.`
/** Twelve short lines: more than `RESULT_CLAMP_LINES` (8), so `resultNeedsClamp` is true. */
export const INBOUND_BODY = [
  'Permission checks pass on every route.',
  '',
  ...Array.from({ length: 11 }, (_, i) => WIDE ? `- Route ${i + 1} is covered across every handler in the permission layer, read by hand and checked by test, line after line.` : `- Route ${i + 1} is covered.`),
].join('\n')
/** The last answer's line count; tuned so that 600 px up leaves both cards above the composer. */
export const TAIL_LINES = Number(process.env.KYBERN_GLASS_TAIL_LINES ?? 16)
export const TAIL = () => `Done. The three files are tidy.\n\n${shortList('Note', TAIL_LINES)}`

const FILES_BEFORE: Record<string, string> = {
  'src/view.ts': ['export function view(rows: string[]) {', '  const out = []', '  for (const row of rows) {', '    out.push(old(row))', '    out.push(pad(row))', '    out.push(trim(row))', '  }', '  return out', '}', ''].join('\n'),
  'src/store.ts': ['export const store = new Map()', 'export const limit = 10', ''].join('\n'),
  'src/theme.ts': ['export const surface = "#101010"', 'export const border = "#202020"', ''].join('\n'),
}
const FILES_AFTER: Record<string, string> = {
  'src/view.ts': ['export function view(rows: string[]) {', '  const out: string[] = []', '  for (const row of rows) {', '    out.push(stable(row))', '    out.push(pad(row, 2))', '  }', '  out.sort()', '  return out', '}', ''].join('\n'),
  'src/store.ts': ['export const store = new Map<string, number>()', 'export const limit = 20', ''].join('\n'),
  'src/theme.ts': ['export const surface = "#101010"', 'export const border = "#262626"', 'export const rim = "#303030"', ''].join('\n'),
}

// ─── Daemon ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]) {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(cwd, '..', 'home'), GIT_AUTHOR_NAME: 'Glass fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Glass fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' } }).trim()
}
function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text) }
}

/** A fresh scratch daemon with the glass thread. Removes and re-creates the data dir only when this fixture owns it. */
export async function seedGlass(dataDir = process.env.KYBERN_DATA_DIR): Promise<GlassFixture> {
  if (!dataDir) throw Error('Set KYBERN_DATA_DIR to a scratch directory whose path contains gpuix-scratch.')
  const data = path.resolve(dataDir)
  if (!data.includes('gpuix-scratch')) throw Error(`Refusing ${data}: the glass fixture's data dir must contain "gpuix-scratch".`)
  const extras = `${data}.fixture`
  const env: Record<string, string> = { KYBERN_DATA_DIR: data, KYBERN_URL: '', KYBERN_TOKEN: '' }
  assertScratchEnv(env)
  for (const dir of [data, extras]) {
    if (!existsSync(dir)) continue
    const owner = path.join(dir, 'glass-owner.json')
    const owned = existsSync(owner) && JSON.parse(readFileSync(owner, 'utf8')).kind === OWNER_KIND
    if (!owned && readdirSync(dir).length) throw Error(`Refusing to reuse ${dir}: it is not empty and not owned by the glass fixture.`)
    if (existsSync(path.join(dir, 'daemon.port'))) {
      const port = readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim()
      if (spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim()) throw Error(`A daemon still listens on ${port} for ${dir}; stop it first.`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
  const home = path.join(extras, 'home'), project = path.join(extras, 'project')
  for (const dir of [data, home, project]) mkdirSync(dir, { recursive: true })
  for (const dir of [data, extras]) writeFileSync(path.join(dir, 'glass-owner.json'), JSON.stringify({ kind: OWNER_KIND, data }))

  // The project: commit A (before the edit turn) and B (after it).
  git(project, ['init', '-q', '-b', 'main'])
  writeFiles(project, { 'README.md': '# Glass fixture\n', ...FILES_BEFORE })
  git(project, ['add', '.']); git(project, ['commit', '-qm', 'Before'])
  const before = git(project, ['rev-parse', 'HEAD'])
  writeFiles(project, FILES_AFTER)
  git(project, ['add', '.']); git(project, ['commit', '-qm', 'After'])
  const after = git(project, ['rev-parse', 'HEAD'])

  const port = await freePort()
  // A small sh supervisor: the daemon also stops when this process dies without running its exit handlers (a killed
  // checker must never leave a scratch daemon behind).
  const supervisor = `"$0" --data-dir "$1" --port "$2" & d=$!; trap 'kill $d 2>/dev/null; wait $d; exit 0' TERM INT HUP; while kill -0 "$3" 2>/dev/null && kill -0 $d 2>/dev/null; do sleep 1; done; kill $d 2>/dev/null; wait $d`
  const daemon = spawn('/bin/sh', ['-c', supervisor, DAEMON, data, String(port), String(process.pid)], { stdio: 'ignore', env: { HOME: home, PATH: '/usr/bin:/bin' } })
  let client: Awaited<ReturnType<typeof connect>> | undefined
  const stop = async () => {
    client?.close()
    if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill(); await new Promise<void>((resolve) => daemon.once('exit', () => resolve())) }
  }
  try {
    const deadline = Date.now() + 30_000
    while (!existsSync(path.join(data, 'daemon.port')) || !existsSync(path.join(data, 'daemon.token'))) {
      if (daemon.exitCode !== null || Date.now() > deadline) throw Error('Scratch daemon failed to start')
      await Bun.sleep(30)
    }
    const actual = Number(readFileSync(path.join(data, 'daemon.port'), 'utf8').trim())
    const token = readFileSync(path.join(data, 'daemon.token'), 'utf8').trim()
    client = await connect({ daemonPid: daemon.pid!, port: actual, token, seeded: false })
    const p = await client.call('projects.add', { path: project, name: 'Glass fixture' })
    const sender = await client.call('threads.create', { project_id: p.id, title: 'Review permission boundaries', provider: { kind: 'claude-code', instance: 'default' } })
    const thread = await client.call('threads.create', { project_id: p.id, title: 'Glass fixture thread', provider: { kind: 'claude-code', instance: 'default' } })

    const turns: { key: string; events: Record<string, unknown>[] }[] = []
    const turn = (key: string, user: unknown[], work: Record<string, unknown>[], answer: string) => {
      const message = uuid(`answer:${key}`)
      turns.push({ key, events: [
        { kind: 'turn_started', message_id: uuid(`user:${key}`), message: { parts: user } },
        ...work,
        { kind: 'assistant_message_completed', message_id: message, origin: { kind: 'root' }, text: answer, thinking: null },
        { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 1000, terminal_message_id: message },
      ] })
    }
    for (let i = 0; i < 2; i++) turn(`filler-${i}`, [{ type: 'text', text: `Check pass ${i + 1}.` }], [], FILLER(i))
    const files = Object.keys(FILES_AFTER)
    const edits = files.flatMap((file, i) => {
      const id = uuid(`edit:${i}`)
      return [
        { kind: 'tool_call_started', call: { id, name: 'Edit', input: { file_path: path.join(project, file), old_string: 'old', new_string: 'stable' } }, origin: { kind: 'root' } },
        { kind: 'tool_call_completed', tool_call_id: id, output: { text: 'The file was updated.' }, is_error: false },
      ]
    })
    turn('edit', [{ type: 'thread_message', message_id: uuid('inbound'), from_thread_id: sender.id, from_title: 'Review permission boundaries', purpose: 'message', body: INBOUND_BODY }], edits, 'Tidied the three files.')
    turn('tail', [{ type: 'text', text: 'Summarise the change.' }], [], TAIL())

    const db = new Database(path.join(data, 'state.sqlite'))
    const editTurn = uuid('turn:edit')
    try {
      db.transaction(() => {
        const insert = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
        for (const [index, { key, events }] of turns.entries()) {
          const at = new Date(Date.UTC(2026, 9, 1, 9, index * 5)).toISOString()
          for (const event of events) insert.run(thread.id, uuid(`turn:${key}`), at, String(event.kind), JSON.stringify(event))
        }
        db.query('INSERT INTO checkpoints(turn_id,thread_id,before_commit,after_commit,created_at) VALUES (?,?,?,?,?)').run(editTurn, thread.id, before, after, new Date(Date.UTC(2026, 9, 1, 9, 5)).toISOString())
        db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?),updated_at=?,status=? WHERE id=?').run(thread.id, '2026-10-01T09:20:00Z', 'idle', thread.id)
      })()
    } finally { db.close() }
    const diff = await client.call('threads.diff', { thread_id: thread.id, turn_id: editTurn, include_patch: false })
    if (diff.files.length !== 3) throw Error(`The edit turn's checkpoint gives ${diff.files.length} files, expected 3`)

    env.KYBERN_URL = `ws://127.0.0.1:${actual}/ws`
    env.KYBERN_TOKEN = token
    const manifest: GlassManifest = { thread: thread.id, sender: sender.id, project: p.id, projectPath: project, editTurn, files, expandFile: 'src/store.ts' }
    writeFileSync(path.join(extras, 'glass-manifest.json'), JSON.stringify(manifest, null, 2))
    return { data, extras, manifest, env, close: stop }
  } catch (error) { await stop(); throw error }
}

if (import.meta.main) {
  const fixture = await seedGlass()
  console.log(JSON.stringify({ ...fixture.manifest, env: { ...fixture.env, KYBERN_TOKEN: '<scratch token>' } }, null, 2))
  await fixture.close()
}
