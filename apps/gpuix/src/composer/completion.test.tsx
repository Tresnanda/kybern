import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { useState } from 'react'
import { useCompletion } from './Completion.tsx'
import { ThemeProvider } from '../ui.tsx'
import type { AttachmentReference } from '../../../../packages/kybern-client/src/composerTokens.ts'

const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)

/** Records every mounted element's custom props, so a row's check mark (`completion-attached-<i>`) can be found. */
function harness() {
  const props = new Map<number, Record<string, any>>()
  const children = new Map<number, number[]>()
  /** A removed element takes its subtree with it (an unchecked row leaves the attached group, whose check mark was a descendant). */
  const drop = (id: number) => { props.delete(id); for (const child of children.get(id) ?? []) drop(child); children.delete(id) }
  const renderer = {
    applyBatch(json: string) {
      for (const [op, id, a, b] of JSON.parse(json) as [string, number, any, any][]) {
        if (op === 'createElement') { props.set(id, {}); children.set(id, []) }
        else if (op === 'setCustomProp' || op === 'setProp') props.get(id) && (props.get(id)![a] = b)
        else if (op === 'appendChild' || op === 'insertBefore') { for (const list of children.values()) { const at = list.indexOf(a); if (at >= 0) list.splice(at, 1) } children.get(id)?.push(a) }
        else if (op === 'removeChild') drop(a)
        else if (op === 'destroyElement' || op === 'removeElement') drop(id)
      }
      return []
    },
    setWindowKeyEvents() {}, setWindowSelectionChange() {}, registerFont() {},
    getWindowSize: () => ({ width: 1200, height: 800 }),
    addLayoutObserver() { return 1 }, removeLayoutObserver() {}, isLayoutObserverActive() { return false },
  }
  const root = createRoot(renderer)
  const find = (testId: string) => [...props.values()].filter((p) => p.testId === testId).at(-1)
  const checked = (i: number) => !!find(`completion-attached-${i}`)
  const has = (testId: string) => !!find(testId)
  return { root, find, checked, has, render: (node: React.ReactNode) => flushSync(() => root.render(<ThemeProvider>{node}</ThemeProvider>)) }
}

const attachment = (label: string, id: string): AttachmentReference => ({ token: `@${label}`, part: { type: 'attachment', asset_id: id, name: `${label}.png`, media_type: 'image/png', size: 1 } })
let api: { text: string; setText: (text: string) => void; onKey: (key: string, shift: boolean) => boolean } | null = null

/** The composer's shape without the native editor: the text is state, the caret sits at its end. */
function Probe({ initial }: { initial: string }) {
  const [text, setText] = useState(initial)
  const completion = useCompletion({ draftKey: `probe:${initial}`, text, setText, attachments: [attachment('image1', 'a1'), attachment('image10', 'a10')], attachmentViews: new Map([['image1', { title: 'Pasted image 1', preview: null }], ['image10', { title: 'Pasted image 10', preview: null }]]), commands: [] })
  api = { text, setText, onKey: completion.onKey }
  return <div testId="probe">{completion.menu(600)}</div>
}

// Review 2026-10-23: the check must follow the text (undo, paste, keyboard deletion, clearing), not a list that can drift.
test('an attached row is checked while its token stands in the text, and picking it again removes it in one edit', () => {
  const h = harness()
  h.render(<Probe initial="look @image1 then @im" />)
  // Rows: image1 (in the text, checked), image10 (not in the text: `@image1` is not `@image10`).
  expect(h.checked(0)).toBe(true)
  expect(h.checked(1)).toBe(false)
  // Enter on the checked row removes the token and the trigger, leaving no gap.
  flushSync(() => api!.onKey('enter', false))
  expect(api!.text).toBe('look then ')
  // An undo (the text comes back) checks it again; a paste of the token anywhere does too.
  flushSync(() => api!.setText('look @image1 then @im'))
  expect(h.checked(0)).toBe(true)
  // Deleting the chip from the keyboard, or clearing the draft, unchecks it.
  flushSync(() => api!.setText('look then @im'))
  expect(h.checked(0)).toBe(false)
  flushSync(() => api!.setText('@image1 @im'))
  expect(h.checked(0)).toBe(true)
  // Picking an unchecked row inserts it, and the row checks.
  flushSync(() => api!.setText('x @im'))
  flushSync(() => api!.onKey('enter', false))
  expect(api!.text).toBe('x @image1 ')
  flushSync(() => api!.setText('x @image1 @im'))
  expect(h.checked(0)).toBe(true)
  expect(h.checked(1)).toBe(false)
  h.root.unmount()
})

// #246: what the draft carries leads the list as one group; only the live row shows a ×, and the highlight starts where it did.
test('attached rows lead the list in one group, and only the live row shows the ×', () => {
  const h = harness()
  h.render(<Probe initial="@image10 @im" />)
  // Unsorted, image1 comes first and is not attached; sorted, the attached image10 leads and image1 follows it.
  expect(h.has('completion-attached-group')).toBe(true)
  expect(h.checked(0)).toBe(true)
  expect(h.checked(1)).toBe(false)
  // The highlight starts on the row that used to be first (image1, now second), so Enter still adds it.
  expect(h.has('completion-remove-0')).toBe(false)
  flushSync(() => api!.onKey('up', false))
  expect(h.has('completion-remove-0')).toBe(true)
  // Enter on the attached row removes it, as before.
  flushSync(() => api!.onKey('enter', false))
  expect(api!.text).toBe('')
  h.root.unmount()
})

test('without attached rows there is no group', () => {
  const h = harness()
  h.render(<Probe initial="@im" />)
  expect(h.has('completion-attached-group')).toBe(false)
  h.root.unmount()
})
