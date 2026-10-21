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
  const native = { text: '', edits: [] as string[], selection: null as null | { start: number; end: number }, rejected: 0 }
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
    getInputSelection() { const at = native.selection ?? { start: native.text.length, end: native.text.length }; return { ...at, reversed: false, composing: false } },
    // The native rule (`input_api.rs` `checked_range`): ordered offsets on UTF-16 character boundaries of the current buffer.
    setInputSelection(_id: number, start: number, end: number) {
      const split = (at: number) => /[\uDC00-\uDFFF]/.test(native.text[at] ?? '') && /[\uD800-\uDBFF]/.test(native.text[at - 1] ?? '')
      if (start > end || end > native.text.length || split(start) || split(end)) { native.rejected++; throw Error('Selection must use ordered UTF-16 character boundaries') }
      native.selection = { start, end }
    },
    editInput(_id: number, edit: { start: number; end: number; text: string }) {
      native.text = native.text.slice(0, edit.start) + edit.text + native.text.slice(edit.end); native.edits.push(edit.text)
      native.selection = { start: edit.start + edit.text.length, end: edit.start + edit.text.length }
    },
    setInputDecorations() {}, hitTestInputDecoration() { return null },
    addLayoutObserver() { return 1 }, removeLayoutObserver() {}, isLayoutObserverActive() { return false },
  }
  const root = createRoot(renderer)
  return { native, committed: () => committed, render: (node: React.ReactNode) => { flushSync(() => root.render(node)) } }
}

const skill = skillReference({ name: 'review-ui', display_name: 'Review UI', path: '/skills/review-ui/SKILL.md', scope: 'user' })
let pick: ((start?: number, end?: number, token?: string) => void) | null = null

/** The composer's shape: the text and the picked chips are state; a pick edits first and registers the chip after. */
function Editor({ initial = '$review' }: { initial?: string }) {
  const [text, setText] = useState(initial)
  const [refs, setRefs] = useState<TokenReference[]>([])
  const ref = useRef<TokenTextareaHandle>(null)
  pick = (start = 0, end = text.length, token = '$review-ui ') => { if (ref.current!.edit(start, end, token, [skill])) setRefs([skill]) }
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

test('a pick replaces only the typed query and leaves the caret right after the chip, even after emoji and before text', async () => {
  const h = harness()
  const before = '👋🏽 hi 🎉 ', after = ' tail'
  h.native.text = `${before}$rev${after}`
  h.native.selection = { start: before.length + 4, end: before.length + 4 }
  h.render(<Editor initial={`${before}$rev${after}`} />)
  // Completion hands the existing space after the caret to the token (`replace` in Completion.tsx).
  flushSync(() => pick!(before.length, before.length + 5, '$review-ui '))
  h.render(<Editor initial={`${before}$rev${after}`} />)
  const chip = `${ICON_PAD}review-ui `
  expect(h.native.text).toBe(`${before}${chip}tail`)
  expect(h.native.edits.at(-1)).toBe(`${ICON_PAD}review-ui`)
  expect(h.native.selection).toEqual({ start: before.length + chip.length, end: before.length + chip.length })
  await Bun.sleep(5)
  expect(h.native.rejected).toBe(0)
  expect(h.native.selection).toEqual({ start: before.length + chip.length, end: before.length + chip.length })
})

test('a caret restore against a native buffer that changed under it is skipped, never thrown', async () => {
  const h = harness()
  h.native.text = '$review'
  h.render(<Editor />)
  flushSync(() => pick!())
  h.render(<Editor />)
  // Typing the native input applied but has not delivered yet: the buffer is shorter than the composer's text.
  h.native.text = '$'; h.native.selection = { start: 1, end: 1 }
  await Bun.sleep(5)
  expect(h.native.selection).toEqual({ start: 1, end: 1 })
})
