import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { VT } from '../vt.ts'
import { CASES } from './cases.ts'
import { snapshot } from './snapshot.ts'

type Dump = { alt: boolean; cursorX: number; cursorY: number; title: string; replies: string[]; modes: Record<string, unknown>; rows: { wrapped: boolean; cells: string[] }[] }
const reference = JSON.parse(readFileSync(new URL('./xterm.json', import.meta.url), 'utf8')) as Record<string, Dump>
/** Which facets of a case the VT is held to; unlisted cases compare everything. */
function run(name: string) {
  const c = CASES.find(item => item.name === name)!
  const replies: string[] = []
  const vt = new VT(c.cols, c.rows, 100, 1_000_000, r => replies.push(r))
  for (const step of c.steps) { if (typeof step === 'string') vt.write(step); else vt.resize(step.resize[0]!, step.resize[1]!) }
  return { vt, replies }
}

describe('matches xterm.js 6.0.0', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const ref = reference[c.name]!, { vt, replies } = run(c.name)
      const rows = snapshot(vt)
      expect(rows.map(r => r.cells.join(' '))).toEqual(ref.rows.map(r => r.cells.join(' ')))
      expect(rows.map(r => r.wrapped)).toEqual(ref.rows.map(r => r.wrapped))
      expect([vt.x, vt.y]).toEqual([ref.cursorX, ref.cursorY])
      expect(vt.alternate).toBe(ref.alt)
      expect(vt.title).toBe(ref.title)
      expect(replies).toEqual(ref.replies)
      expect({ bracketedPaste: vt.bracketedPaste, applicationCursor: vt.applicationCursor, mouse: vt.mouseTracking > 0 ? vt.mouseTracking : 0 }).toMatchObject({ bracketedPaste: ref.modes.bracketedPaste, applicationCursor: ref.modes.applicationCursor })
    })
  }
})
