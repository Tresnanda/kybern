/**
 * Scratch daemon + deterministic Notes/Tasks fixtures for the visual pair tool.
 *
 * Everything lives under `<scratch>/visual-pair`, whose path contains
 * `gpuix-scratch`; nothing touches `~/.kybern`. Data goes in through daemon RPCs
 * only (plus the asset upload endpoint for the image block).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'

export const SCRATCH = process.env.VISUAL_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/visual-pair'
export const DATA_DIR = path.join(SCRATCH, 'data')
export const DAEMON_BIN = process.env.KYBERND ?? '/Applications/kybern.app/Contents/MacOS/kybernd'
const STATE = path.join(SCRATCH, 'state.json')

if (!SCRATCH.includes('gpuix-scratch')) throw new Error('VISUAL_SCRATCH must contain gpuix-scratch')

export type RunState = { daemonPid: number; port: number; token: string; vitePid?: number; vitePort?: number; seeded: boolean }

export function readState(): RunState | null {
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8')) as RunState
    process.kill(s.daemonPid, 0)
    return s
  } catch {
    return null
  }
}
export function writeState(s: RunState) {
  mkdirSync(SCRATCH, { recursive: true })
  writeFileSync(STATE, JSON.stringify(s))
}

export async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = s.port!
  await s.stop(true)
  return port
}

export async function startDaemon(fresh: boolean): Promise<RunState> {
  const existing = readState()
  if (existing && !fresh) return existing
  if (existing) stopPid(existing.daemonPid)
  if (fresh) rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })
  const port = await freePort()
  if (port === 4219) throw new Error('port 4219 is reserved')
  const child: ChildProcess = spawn(DAEMON_BIN, ['--data-dir', DATA_DIR, '--port', String(port)], {
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  const tokenFile = path.join(DATA_DIR, 'daemon.token')
  const portFile = path.join(DATA_DIR, 'daemon.port')
  for (let i = 0; i < 100; i++) {
    if (existsSync(tokenFile) && existsSync(portFile) && readFileSync(portFile, 'utf8').trim() === String(port)) break
    await Bun.sleep(100)
  }
  const token = readFileSync(tokenFile, 'utf8').trim()
  const state: RunState = { daemonPid: child.pid!, port, token, seeded: false }
  writeState(state)
  return state
}

export function stopPid(pid?: number) {
  if (!pid) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
}

export async function connect(state: RunState): Promise<KybernClient> {
  const client = new KybernClient(
    { url: `ws://127.0.0.1:${state.port}/ws`, token: state.token },
    {
      createSocket: (url, token) =>
        new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as unknown as string[]),
    },
  )
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timeout')), 15000)
    client.onStatus((status) => {
      if (status === 'open') {
        clearTimeout(timer)
        resolve()
      }
    })
    client.connect()
  })
  return client
}

/** A small deterministic gradient PNG (no image dependency). */
export function gradientPng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = 40 + Math.round((x / w) * 150)
      raw[o + 1] = 90 + Math.round((y / h) * 100)
      raw[o + 2] = 200 - Math.round(((x + y) / (w + h)) * 120)
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function gitProject(dir: string, readme: string) {
  mkdirSync(dir, { recursive: true })
  if (existsSync(path.join(dir, '.git'))) return
  writeFileSync(path.join(dir, 'README.md'), readme)
  const run = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@x.io', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@x.io' } })
  run('init', '-q', '-b', 'main')
  run('add', '.')
  run('commit', '-q', '-m', 'Initial commit')
}

const TASKS: [string, string, 'inbox' | 'todo' | 'done' | 'canceled', 0 | 1 | 2 | 3 | 4, 0 | 1][] = [
  ['Fix sidebar collapse jitter on resize', 'The thread panel flickers for a frame when the window crosses 900 px.\n\n- [ ] Reproduce with the scratch daemon\n- [ ] Coalesce geometry reads\n- [x] Read the layout code', 'todo', 1, 0],
  ['Ship notes image blocks', 'Paste or drop an image into a note and keep a `kybern://asset` link.\n\n- [x] Upload endpoint\n- [x] Render block\n- [ ] Alt text editing', 'todo', 2, 0],
  ['Review keyboard navigation in Tasks', 'Arrow keys, Enter and Escape should work in the list and the board.', 'inbox', 3, 0],
  ['Add task search to the palette', '', 'inbox', 0, 0],
  ['Polish task detail properties', 'Status, priority and project pickers share one popup style.\n\n- [ ] Status\n- [ ] Priority\n- [ ] Project', 'todo', 3, 0],
  ['Document the Orchestrator V2 contract', 'Write the lead and helper thread contract in `docs/`.', 'inbox', 4, 1],
  ['Investigate memory growth in long threads', 'Mounted history should stay bounded. Measure with vmmap before and after.\n\n- [ ] Baseline\n- [ ] Fix\n- [ ] Re-measure', 'todo', 1, 0],
  ['Rename Environments copy', '', 'done', 0, 0],
  ['Upgrade Tauri to 2.11', 'Check plugin compatibility first.', 'done', 3, 0],
  ['Remove the old GPUI client', '', 'canceled', 4, 0],
  ['Fix traffic light centring', 'Dots sit on the 46 px midline.\n\n- [x] Dev build\n- [x] Release build', 'done', 2, 0],
  ['Coordinator setup note wording', 'Sentence case, verb-first buttons.', 'inbox', 3, 0],
  ['Mobile: pairing QR scanner', 'Scan the daemon QR and save credentials before connecting.\n\n- [ ] Camera permission\n- [ ] Save before connect', 'todo', 2, 0],
  ['Usage rings flicker after sleep', '', 'inbox', 2, 0],
  ['Release 0.9.2 notes', 'Collect changes from the merged PRs.\n\n- [x] 0.9.1 recap\n- [ ] Draft\n- [ ] Review', 'todo', 4, 0],
  ['Stream jitter buffer tuning', '', 'inbox', 0, 0],
  ['Settings: appearance previews', 'Light, dark and system previews need the real tokens.', 'todo', 3, 0],
  ['Handle daemon version skew banner', 'Offer a restart when the staged binary is newer.', 'inbox', 1, 0],
  ['Palette: recent threads section', '', 'done', 3, 0],
  ['Write a better empty state for Notes', 'Illustration optional. Copy: "Capture a thought".', 'inbox', 4, 0],
  ['Check APFS snapshots after builds', '', 'canceled', 0, 0],
  ['Publish docs site changelog page', 'The changelog page needs the 0.9 entries.\n\n- [ ] Copy entries\n- [ ] Check links', 'todo', 3, 1],
  ['Docs: pairing with Tailscale', 'Step-by-step with screenshots.', 'inbox', 3, 1],
  ['Docs: keyboard shortcut table', '', 'done', 4, 1],
  ['Follow up with the design review notes', 'Pull the open questions out of the review note into tasks.', 'inbox', 2, 0],
]

export async function seed(state: RunState) {
  const client = await connect(state)
  try {
    const a = path.join(SCRATCH, 'kybern-app')
    const b = path.join(SCRATCH, 'docs-site')
    gitProject(a, '# kybern-app\n')
    gitProject(b, '# docs-site\n')
    const pa = await client.call('projects.add', { path: a, name: 'kybern-app' })
    const pb = await client.call('projects.add', { path: b, name: 'docs-site' })
    const projects = [pa, pb]
    const tasks = [] as { id: string; key: string }[]
    for (const [title, body, status, priority, p] of TASKS) {
      const t = await client.call('tasks.items.create', { scope: 'project', project_id: projects[p]!.id, title, body, status, priority })
      tasks.push(t)
    }
    const global = await client.call('tasks.items.create', { scope: 'global', title: 'Back up the Time Machine drive', body: 'Not tied to a project.', priority: 3 })
    tasks.push(global)

    // Image asset for the "Moodboard" note.
    const png = gradientPng(640, 360)
    const upload = await fetch(`http://127.0.0.1:${state.port}/assets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}`, 'content-type': 'image/png', 'x-kybern-filename': 'moodboard.png' },
      body: new Uint8Array(png),
    })
    const asset = (await upload.json()) as { id: string }

    const link = (i: number) => `[${tasks[i]!.key}](kybern://task/${tasks[i]!.id})`
    const notes: { title: string; body: string; pin?: boolean; scope?: 'global' | 'project'; project?: number; tasks?: number[] }[] = [
      { title: 'Sprint planning', body: 'Goals for the week:\n\n- [x] Land notes image blocks\n- [x] Fix sidebar jitter\n- [ ] Tasks board polish\n- [ ] Mobile pairing', pin: true, project: 0 },
      { title: 'Release checklist 0.9.2', body: '## Before tagging\n\n- [x] Changelog drafted\n- [x] Protocol snapshot reviewed\n- [ ] Desktop smoke test\n- [ ] Mobile preview build\n\n## After\n\n- [ ] Announce in the channel', pin: true, project: 0 },
      {
        title: 'Design review notes',
        body: `# Design review\n\nWe walked through the **Notes** and **Tasks** surfaces with the whole team. The overall direction is right; a few details need another pass.\n\n## What worked\n\n- The gallery density feels calm\n- Pinned notes read first\n- The editor column is comfortable at 640 px\n\n## Open questions\n\n1. Should quick capture keep the last title?\n2. Do we show the outline by default?\n3. How do we label running tasks?\n\n> Keep the kit appearance; reuse components before writing new styles.\n\n### Snippet\n\n\`\`\`ts\nexport function editedAgo(date: string) {\n  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-1, 'day')\n}\n\`\`\`\n\nFollow-ups are filed as tasks: ${link(24)}.\n`,
        project: 0,
        tasks: [24],
      },
      { title: 'API sketch', body: 'Draft shape for the notes list endpoint.\n\n```json\n{ "notes": [{ "id": "…", "title": "Sprint planning", "pinned": true }] }\n```\n\nPagination is not needed yet: the gallery loads everything.', project: 0 },
      { title: 'Meeting · Coordinator sync', body: 'Attendees: Ana, Ben, Chris.\n\nWe agreed the Coordinator should set itself up and ask before filing tasks. Ben will write the setup note wording; Chris owns the brief. Revisit next Thursday.', project: 0 },
      { title: 'Ideas', body: 'A thread-note quick capture from the palette.', scope: 'global' },
      { title: 'Moodboard', body: `Reference for the release background.\n\n![moodboard](kybern://asset/${asset.id})\n\nThe gradient should stay quiet behind the update notice.`, project: 1 },
      { title: 'Docs site outline', body: '1. Getting started\n2. Pairing a phone\n3. Agents and harnesses\n4. Keyboard shortcuts\n\nOpen: where do changelogs live?', project: 1, tasks: [21] },
      { title: 'Scratchpad', body: 'Global notes live across projects.', scope: 'global' },
    ]
    for (const n of notes) {
      const scope = n.scope ?? 'project'
      const created = await client.call('notes.create', { scope, project_id: scope === 'project' ? projects[n.project ?? 0]!.id : null, title: n.title, body: n.body })
      if (n.pin) await client.call('notes.pin', { id: created.id, pinned: true })
      for (const ti of n.tasks ?? []) {
        const t = await client.call('tasks.items.get', { id: tasks[ti]!.id })
        await client.call('tasks.items.update', { id: tasks[ti]!.id, note_ids: [...(t.task?.note_ids ?? []), created.id] })
      }
      await Bun.sleep(30)
    }
    writeState({ ...state, seeded: true })
  } finally {
    client.close?.()
  }
}
