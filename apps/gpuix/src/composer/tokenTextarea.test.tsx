import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { useRef, useState } from 'react'
import { TokenTextarea, type TokenTextareaHandle } from './TokenTextarea.tsx'
import { skillReference } from './Completion.tsx'
import { ICON_PAD, type TokenReference } from './token-text.ts'

const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)

/** A renderer that records what the editor writes natively and the `value` React last committed for the textarea. */
function harness() {
  const native = { text: '', edits: [] as string[] }
  let committed: string | null = null
  const renderer = {
    applyBatch(json: string) {
      for (const [op, , a, b] of JSON.parse(json) as [string, number, any, any][]) {
        if ((op === 'setProp' || op === 'setCustomProp') && a === 'value') committed = b
      }
      return []
    },
    setWindowKeyEvents() {}, setWindowSelectionChange() {},
    registerFont() {}, getTextSelection() { return null }, setTextSelection() {},
    getInputSelection() { return { start: native.text.length, end: native.text.length, reversed: false, composing: false } },
    setInputSelection() {},
    editInput(_id: number, edit: { start: number; end: number; text: string }) { native.text = native.text.slice(0, edit.start) + edit.text + native.text.slice(edit.end); native.edits.push(edit.text) },
    setInputDecorations() {}, hitTestInputDecoration() { return null },
    addLayoutObserver() { return 1 }, removeLayoutObserver() {}, isLayoutObserverActive() { return false },
  }
  const root = createRoot(renderer)
  return { native, committed: () => committed, render: (node: React.ReactNode) => { flushSync(() => root.render(node)) } }
}

const skill = skillReference({ name: 'review-ui', display_name: 'Review UI', path: '/skills/review-ui/SKILL.md', scope: 'user' })
let pick: (() => void) | null = null

/** The composer's shape: the text and the picked chips are state; a pick edits first and registers the chip after. */
function Editor() {
  const [text, setText] = useState('$review')
  const [refs, setRefs] = useState<TokenReference[]>([])
  const ref = useRef<TokenTextareaHandle>(null)
  pick = () => { if (ref.current!.edit(0, text.length, '$review-ui ', [skill])) setRefs([skill]) }
  return <TokenTextarea testId="composer" editorRef={ref} nativeRef={() => {}} value={text} references={refs} onChange={e => setText(e.value ?? '')} />
}

test('a picked skill is written natively as its chip, and the next render keeps that exact text', () => {
  const h = harness()
  h.native.text = '$review'
  h.render(<Editor />)
  flushSync(() => pick!())
  h.render(<Editor />)
  const chip = `${ICON_PAD}review-ui `
  // Before the fix the native write was the raw `$review-ui ` (the chip was not registered yet), and the decorations of the
  // next render described `  review-ui ` instead: the chip appeared only after the next keystroke re-applied them.
  expect(h.native.edits.at(-1)).toBe(chip)
  expect(h.native.text).toBe(chip)
  expect(h.committed()).toBe(chip)
})
