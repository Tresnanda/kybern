/**
 * Cached-island check for the patched GPUIX (run by native/update.sh):
 *  1. 300 rows render pixel-identical plain and as islands,
 *  2. hover still paints inside an island,
 *  3. a loader keeps animating inside its island,
 *  4. islands inside a <virtual-list> row render (they fall back to inline),
 *  5. an island that changes after mount repaints (no stale replay); covered
 *     by check 1, since the lab flips a label inside an island at 800 ms.
 */
import { readFileSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { PATCHED_NATIVE } from '../src/native/local-build.ts'

if (!PATCHED_NATIVE) throw new Error('native/build/gpuix-native.darwin-arm64.node is missing: run native/update.sh')
const dir = path.join(tmpdir(), `island-check-${process.pid}`)
mkdirSync(dir, { recursive: true })
const lab = path.join(import.meta.dir, 'island-lab.tsx')

async function shots(mode: string, still: boolean, list = false, hover = false) {
  const app = await launch({
    command: 'bun',
    args: [lab, mode],
    env: { ISLAND_LAB_CLOCK: '1', KYBERN_APPEARANCE: 'dark', KYBERN_LOADER_TICK_MS: '100', NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH!, ...(still ? { ISLAND_LAB_STILL: '1' } : {}), ...(list ? { ISLAND_LAB_LIST: '1' } : {}), ...(!hover ? { ISLAND_LAB_NO_HOVER: '1' } : {}) },
  })
  try {
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await app.getByText('late: island updated').waitFor({ timeoutMs: 60_000 })
    await app.getByText('late: island updated').hover()
    const tag = `${mode}-${still}-${list}`
    const a = path.join(dir, `${tag}-a.png`)
    const b = path.join(dir, `${tag}-b.png`)
    const h = path.join(dir, `${tag}-hover.png`)
    await app.screenshot({ path: a })
    const first = readFileSync(a)
    const deadline = Date.now() + 3000
    do {
      await app.screenshot({ path: b })
      if (still || !first.equals(readFileSync(b))) break
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    await app.getByText('Thread row 3 with a reasonably long title').hover()
    await app.screenshot({ path: h })
    return { a: readFileSync(a), b: readFileSync(b), hover: readFileSync(h) }
  } finally { await app.close() }
}

const plain = await shots('plain', true)
const island = await shots('island', true)
const plainHover = await shots('plain', true, false, true)
const islandHover = await shots('island', true, false, true)
const live = await shots('island', false)
const listPlain = await shots('plain', true, true)
const listIsland = await shots('island', true, true)
const results = [
  ['rows identical plain vs island', plain.a.equals(island.a)],
  ['hover identical plain vs island', plainHover.hover.equals(islandHover.hover)],
  ['hover repaints inside an island', !island.a.equals(islandHover.hover)],
  ['loader animates inside an island', !live.a.equals(live.b)],
  ['islands inside a virtual list render (inline fallback)', listPlain.a.equals(listIsland.a)],
] as const
for (const [name, ok] of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
if(results.some(([,ok])=>!ok)&&process.env.KYBERN_VERIFY_OUTPUT){
  const failure=path.join(process.env.KYBERN_VERIFY_OUTPUT,'island-failure')
  mkdirSync(failure,{recursive:true});cpSync(dir,failure,{recursive:true})
  console.error(`Island comparison evidence: ${failure}`)
}
rmSync(dir, { recursive: true, force: true })
if (results.some(([, ok]) => !ok)) process.exit(1)
