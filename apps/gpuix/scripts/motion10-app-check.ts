// motion10 in the running app, used like the user does, against the motion10 scratch daemon (port 4311, seeded with a note and two
// tasks): Notes → press and hold a note card (the thumb settles to 0.985), Tasks → ⌘A → press Send to agent (0.97 over 80 ms) and
// Delete (0.97, no transition) with the pointer leaving before release (no click), and the Projects disclose (0.96 over 150 ms).
// Window-ID captures with the automation clock paused and stepped (visual only), four modes.
//   bun native/ui-lease.ts motion10 bun scripts/motion10-app-check.ts
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { pngPixels } from '../native/clip-pixels.ts'
const DATA = '/Users/mymac/projects/ade-gpuix-scratch/motion10', CLIENT = '/Users/mymac/projects/ade-gpuix-scratch/motion10-client'
if (path.resolve(DATA).includes('/.kybern')) throw Error('Refusing the real data dir')
const root = '/Users/mymac/projects/ade/previews/gpuix/phase2/motion10/app'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const lum = (p: number[]) => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!
const results: Record<string, unknown> = {}
for (const theme of ['dark', 'light'] as const) for (const reduced of ['0', '1']) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, dir = path.join(root, label); mkdirSync(dir, { recursive: true })
  execFileSync('sh', ['-c', `rm -f '${DATA}/gpuix-ui.json' '${CLIENT}'/workspace-*.json`])
  const f = await launchFixture(path.join(import.meta.dir, '../src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', KYBERN_WINDOW_SIZE: '1280x820', KYBERN_DATA_DIR: DATA, KYBERN_CLIENT_CONFIG_DIR: CLIENT, KYBERN_URL: '', KYBERN_TOKEN: '' })
  const out: Record<string, { frame: string; edge: number }[]> = {}
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    const windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
    const shot = async (name: string) => { await sleep(120); const file = path.join(dir, `${name}.png`); execFileSync('screencapture', ['-x', '-o', '-l', windowId, file]); return file }
    // Left edge of the box at (x, y) (logical, content coordinates): first column from x-12 that differs from the pixel at x-12.
    const edge = (file: string, x: number, y: number) => { const img = pngPixels(file), sc = img.width / 1280, top = img.height / sc - 820, Y = (y + top) * sc, bg = lum(img.at((x - 12) * sc, Y)); for (let X = (x - 12) * sc; X < (x + 30) * sc; X++) if (Math.abs(lum(img.at(X, Y)) - bg) > 3) return X / sc; return -1 }
    const hold = async (name: string, at: { x: number; y: number }, probe: { x: number; y: number }, down: number[], up: number[], away = false) => {
      const rows: { frame: string; edge: number }[] = []
      await a.mouse.move(at); await sleep(300)
      await a.clock.pause()
      const rest = await shot(`${name}-rest`); rows.push({ frame: 'rest', edge: edge(rest, probe.x, probe.y) })
      await a.mouse.down(at)
      let t = 0
      for (const o of down) { if (o > t) await a.clock.fastForward(o - t); t = o; const file = await shot(`${name}-down-${String(o).padStart(3, '0')}`); rows.push({ frame: `down ${o}`, edge: edge(file, probe.x, probe.y) }) }
      await a.clock.fastForward(300)
      // Leaving before release cancels the click (Delete would delete); the press still restores on mouse up.
      if (away) await a.mouse.move({ x: at.x, y: at.y - 120 })
      await a.mouse.up(away ? { x: at.x, y: at.y - 120 } : at); t = 0
      for (const o of up) { if (o > t) await a.clock.fastForward(o - t); t = o; const file = await shot(`${name}-up-${String(o).padStart(3, '0')}`); rows.push({ frame: `up ${o}`, edge: edge(file, probe.x, probe.y) }) }
      await a.clock.resume()
      out[name] = rows
    }
    // Notes: the card's thumb.
    await a.getByTestId('rail-notes').click()
    const id = JSON.parse(execFileSync('/Applications/kybern.app/Contents/MacOS/kybern', ['note', '--data-dir', DATA, '--json', 'list'], { encoding: 'utf8' })).notes.find((n: { title: string }) => n.title === 'Launch plan').id
    await a.getByTestId(`note-card-${id}`).waitFor({ timeoutMs: 20_000 }); await sleep(800)
    // Press on the title under the thumb (the whole card is pressable) and probe the thumb's left edge.
    const c = await a.getByTestId(`note-card-${id}`).bounds()
    await hold('note-thumb', { x: c.x + c.width / 2, y: c.y + c.height - 14 }, { x: c.x, y: c.y + 70 }, [0, 35, 70, 140], [0, 35, 70, 140])
    // Tasks: ⌘A → the selection bar.
    await a.getByTestId('rail-tasks').click(); await sleep(800)
    await a.getByTestId('app-ready').press('cmd-a'); await a.getByTestId('task-batch-open').waitFor()
    await sleep(400)
    const send = await a.getByTestId('task-batch-open').bounds(), del = await a.getByTestId('task-selection-delete').bounds()
    await hold('selbar-send', { x: send.x + send.width / 2, y: send.y + send.height / 2 }, { x: send.x, y: send.y + send.height / 2 }, [0, 20, 40, 80], [0, 20, 40, 80], true)
    await hold('selbar-delete', { x: del.x + del.width / 2, y: del.y + del.height / 2 }, { x: del.x + 10, y: del.y + del.height / 2 }, [0, 20], [0, 20], true)
    await a.getByTestId('app-ready').press('escape'); await sleep(300)
    const projects = await a.getByText('Projects').bounds()
    await hold('projects-disclose', { x: projects.x + projects.width / 2, y: projects.y + projects.height / 2 }, { x: projects.x, y: projects.y + projects.height / 2 }, [0, 50, 100, 150], [0, 50, 100, 150], true)
  } finally { await f.close() }
  results[label] = out
  console.log(`ok ${label}`)
  for (const [name, rows] of Object.entries(out)) console.log(`  ${name.padEnd(18)} ${rows.map(r => `${r.frame}=${r.edge.toFixed(1)}`).join('  ')}`)
}
writeFileSync(path.join(root, 'metrics.json'), JSON.stringify(results, null, 2))
process.exit(0)
