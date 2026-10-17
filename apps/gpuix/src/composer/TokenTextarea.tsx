import { useGpuixRequired, type PublicInstance, type TextareaProps } from '@gpuix/react'
import { useImperativeHandle, useRef, useEffect, type Ref } from 'react'
import { spawnSync } from 'node:child_process'
import { DecoratedTextarea } from '../native/decorated-input.tsx'
import { nativeCapabilities, type InputSelection } from '../native/api.ts'
import { useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'
import { tinted } from '../transcript/kit.tsx'
import { RichHistory } from '../notes/rich-text.ts'
import { editTokenText, tokenDisplayOffset, tokenSourceOffset, tokenText, type TokenReference } from './token-text.ts'

export interface TokenTextareaHandle {
  selection(): InputSelection
  edit(start: number, end: number, text: string): boolean
}
interface Props extends TextareaProps {
  testId: string
  value: string
  references: readonly TokenReference[]
  editorRef: Ref<TokenTextareaHandle>
  nativeRef: Ref<PublicInstance>
  onEditorError?: (message: string) => void
}
const historyDoc = (text: string) => ({ text, marks: [], lines: [] })
/** Inline labels are native atomic runs. Offset conversion is confined here;
 * completion queries, clipboard serialization and wire parts use raw tokens. */
export function TokenTextarea({ references, editorRef, nativeRef, onEditorError, ...props }: Props) {
  const t = useTheme()
  const accent = t.v('--color-accent-blue')
  const renderer = useGpuixRequired()
  const node = useRef<PublicInstance | null>(null)
  const projection = tokenText(props.value, references)
  const live = useRef(projection)
  live.current = projection
  const history = useRef(new RichHistory({ doc: historyDoc(props.value), start: props.value.length, end: props.value.length }))
  const nativeReplacement = useRef<string | null>(null)
  const lastEmitted = useRef(props.value)
  const caret = useRef<Pick<InputSelection, 'start' | 'end' | 'reversed'> | null>(null)
  const composing = useRef(false)
  const read = (): InputSelection => {
    if (!node.current) return { start: 0, end: 0, composing: false, reversed: false }
    const range = nativeCapabilities(renderer).getInputSelection(node.current.id), doc = live.current
    return { ...range, start: tokenSourceOffset(doc, range.start), end: tokenSourceOffset(doc, range.end, true) }
  }
  const emit = (value: string, at: number, typed: boolean, record = true) => {
    lastEmitted.current = value; caret.current = { start: at, end: at, reversed: false }
    live.current = tokenText(value, references)
    if (record) history.current.record({ doc: historyDoc(value), start: at, end: at }, typed)
    props.onChange?.({ value, elementId: node.current?.id ?? 0, eventType: 'change' })
  }
  const install = (value: string, at: number, record: boolean, selection?: Pick<InputSelection, 'start' | 'end' | 'reversed'>) => {
    if (!node.current || props.readOnly || read().composing) return false
    const previous = live.current, next = tokenText(value, references)
    nativeReplacement.current = next.text
    nativeCapabilities(renderer).editInput(node.current.id, { start: 0, end: previous.text.length, text: next.text, expectedValue: previous.text })
    emit(value, at, false, record)
    if (selection) caret.current = selection
    return true
  }
  useImperativeHandle(editorRef, () => ({ selection: read, edit: (start, end, text) => {
    const value = live.current.source
    return install(value.slice(0, start) + text + value.slice(end), start + text.length, true)
  } }))
  useEffect(() => {
    if (props.value !== lastEmitted.current) {
      lastEmitted.current = props.value
      history.current.record({ doc: historyDoc(props.value), start: props.value.length, end: props.value.length }, false)
    }
    if (caret.current != null && node.current) {
      const start = tokenDisplayOffset(projection, caret.current.start)
      const end = tokenDisplayOffset(projection, caret.current.end, true)
      const id = node.current.id, reversed = caret.current.reversed
      const expected = props.value
      // React host value updates are batched after effects. Restore the range
      // after that commit rather than having the host overwrite it again.
      const restore = setTimeout(() => {
        if (node.current?.id === id && live.current.source === expected && !read().composing) nativeCapabilities(renderer).setInputSelection(id, start, end, reversed)
      }, 0)
      caret.current = null
      return () => clearTimeout(restore)
    }
  }, [props.value, projection.text])
  const rememberSelection = () => {
    const selection = read()
    history.current.selection(selection.start, selection.end, selection.reversed)
  }
  return <DecoratedTextarea {...props} value={projection.text}
    ref={element => { node.current = element; if (typeof nativeRef === 'function') nativeRef(element); else if (nativeRef) nativeRef.current = element }}
    decorations={projection.spans.map((span, index) => {
      const icon = references.find(r => r.token === span.token)?.icon
      return { start: span.start, end: span.end, atomic: true, id: `token:${index}:${span.token}`, style: { color: accent, fontWeight: 500 }, ...(icon ? { icon: { svg: tinted(icon, accent), color: '', font: FONT_MONO, size: 13.3 } } : {}) }
    })}
    interceptKeys={[...new Set([...(props.interceptKeys ?? []), 'c', 'x', 'z', 'y', 'backspace', 'delete'])]}
    onChange={event => {
      const value = event.value ?? ''
      if (nativeReplacement.current === value) { nativeReplacement.current = null; return }
      const previous = live.current, range = node.current ? nativeCapabilities(renderer).getInputSelection(node.current.id) : null
      const next = editTokenText(previous, value)
      const interim = tokenText(next.value, references)
      const at = range ? tokenSourceOffset(interim, range.start, true) : next.caret
      // Ordinary native typing has already placed the caret; no second write.
      emit(next.value, at, !composing.current && Math.abs(value.length - previous.text.length) === 1, !range?.composing)
      composing.current = !!range?.composing
      caret.current = null
    }}
    onClick={event => { rememberSelection(); props.onClick?.(event) }}
    onKeyUp={event => {
      const range = read()
      if (composing.current && !range.composing) {
        composing.current = false
        history.current.record({ doc: historyDoc(live.current.source), ...range }, false)
      }
      rememberSelection()
      props.onKeyUp?.(event)
    }}
    onKeyDown={event => {
      const range = read(), mod = event.modifiers?.cmd || event.modifiers?.ctrl
      const saved = history.current.entries[history.current.index]!
      if ((event as typeof event & { requestId?: number }).requestId != null && (saved.start !== range.start || saved.end !== range.end || saved.reversed !== range.reversed)) history.current.selection(range.start, range.end, range.reversed)
      if (!range.composing && mod && !event.modifiers?.alt) {
        if ((event.key === 'c' || event.key === 'x') && range.start !== range.end) {
          event.preventDefault()
          const copied = spawnSync('pbcopy', [], { input: live.current.source.slice(range.start, range.end), stdio: ['pipe', 'ignore', 'ignore'] })
          if (copied.error || copied.status !== 0) { onEditorError?.('Unable to copy. Try the keyboard shortcut again.'); return }
          if (event.key === 'x' && !props.readOnly) install(live.current.source.slice(0, range.start) + live.current.source.slice(range.end), range.start, true)
          return
        }
        if (!props.readOnly && (event.key === 'z' || (event.key === 'y' && event.modifiers?.ctrl))) {
          event.preventDefault()
          const entry = history.current.restore(event.key === 'y' || event.modifiers?.shift ? 1 : -1)
          if (entry) install(entry.doc.text, entry.start, false, { start: entry.start, end: entry.end, reversed: !!entry.reversed })
          return
        }
      }
      props.onKeyDown?.(event)
    }}
  />
}
