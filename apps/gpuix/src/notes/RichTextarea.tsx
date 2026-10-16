import { useGpuixRequired, type PublicInstance, type TextareaProps } from '@gpuix/react'
import { useImperativeHandle, useRef, useState, useEffect, type Ref } from 'react'
import { DecoratedTextarea } from '../native/decorated-input.tsx'
import { decoratedInputCapabilities, nativeCapabilities, type InputDecoration, type InputSelection } from '../native/api.ts'
import { noteInputMarkColors } from '../native/input-marks.ts'
import { useTheme } from '../ui.tsx'
import { toast } from '../shell/toasts.tsx'
import { formatBlock } from './blocks.ts'
import { parseRichText, RichHistory, richInputRule, serializeRichText, setRichLink, textEdit, toggleRichChecklist, toggleRichMark, updateRichText, type RichKind, type RichText } from './rich-text.ts'

export interface RichTextareaHandle {
  focus(): void
  mark(marker: string): void
  block(kind: string): void
  link(label: string, href: string): void
  selection(): InputSelection
}
interface Props extends Omit<TextareaProps, 'onChange' | 'ref' | 'value'> {
  testId: string
  value: string
  onChange(value: string): void
  editorRef?: Ref<RichTextareaHandle>
  nativeRef?: Ref<PublicInstance>
  onOpenLink?: (href: string) => void
  inlineOnly?: boolean
  markdownContext?: string
}
const MARK_KEYS: Record<string, RichKind> = { '**': 'bold', '*': 'italic', '~~': 'strike', '`': 'code' }

/** A native formatted buffer, shared by notes and task descriptions. Native
 * selection, IME and clipboard stay on visible text; semantic marks live with
 * the document and its history, including edits that change no characters. */
export function RichTextarea({ value, onChange, editorRef, nativeRef, onOpenLink, inlineOnly, markdownContext = '', ...props }: Props) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const input = useRef<PublicInstance | null>(null)
  const [doc, setDoc] = useState(() => parseRichText(value, markdownContext))
  const live = useRef(doc)
  const lastSource = useRef(value)
  const lastContext = useRef(markdownContext)
  const history = useRef(new RichHistory({ doc, start: 0, end: 0 }))
  const range = useRef<InputSelection>({ start: 0, end: 0, reversed: false, composing: false })
  const pending = useRef<RichKind[] | null>(null)
  const replacement = useRef<string | null>(null)
  const pendingCaret = useRef<InputSelection | null>(null)
  const composing = useRef(false)
  const read = () => {
    if (input.current) range.current = nativeCapabilities(renderer).getInputSelection(input.current.id)
    return range.current
  }
  const focus = () => { if (input.current) renderer.focusElement?.(input.current.id) }
  const select = (selection: InputSelection) => {
    range.current = selection
    if (!input.current) return
    nativeCapabilities(renderer).setInputSelection(input.current.id, selection.start, selection.end, selection.reversed)
  }
  const publish = (next: RichText) => {
    live.current = next; setDoc(next)
    lastSource.current = serializeRichText(next)
    onChange(lastSource.current)
  }
  const finishComposition = () => {
    if (!composing.current || read().composing) return
    composing.current = false
    publish(live.current)
    history.current.record({ doc: live.current, ...range.current }, false)
  }
  const install = (next: RichText, selection: InputSelection, emit = true) => {
    if (!input.current || read().composing || props.readOnly) return false
    const previous = live.current
    if (previous.text !== next.text) {
      replacement.current = next.text
      nativeCapabilities(renderer).editInput(input.current.id, { start: 0, end: previous.text.length, text: next.text, expectedValue: previous.text })
    }
    if (emit) publish(next)
    else { live.current = next; setDoc(next) }
    pendingCaret.current = selection
    select(selection)
    return true
  }
  const transact = (next: RichText, selection = range.current) => {
    history.current.selection(range.current.start, range.current.end, range.current.reversed)
    if (!install(next, selection)) return
    history.current.record({ doc: next, ...selection }, false)
    focus()
  }
  const mark = (marker: string) => {
    const kind = MARK_KEYS[marker]
    if (!kind || props.readOnly || range.current.composing) return
    const selection = range.current
    if (selection.start === selection.end) {
      const active = pending.current ?? live.current.marks.filter(m => m.start <= selection.start && m.end >= selection.end && m.kind !== 'marker' && m.kind !== 'link').map(m => m.kind)
      pending.current = active.includes(kind) ? active.filter(k => k !== kind) : [...active, kind]
      focus(); return
    }
    const next = toggleRichMark(live.current, selection.start, selection.end, kind)
    if (next === live.current) {
      toast.error('Unable to format this selection', { description: 'Select text within one formatting range and try again.' })
      return
    }
    transact(next)
  }
  useImperativeHandle(editorRef, () => ({
    focus, mark, selection: read,
    block: kind => {
      const next = parseRichText(formatBlock(serializeRichText(live.current), kind), markdownContext)
      transact(next, { ...range.current, start: Math.min(range.current.start, next.text.length), end: Math.min(range.current.end, next.text.length) })
    },
    link: (label, href) => {
      const selection = range.current
      const text = label || live.current.text.slice(selection.start, selection.end) || href
      let next = updateRichText(live.current, live.current.text.slice(0, selection.start) + text + live.current.text.slice(selection.end))
      const end = selection.start + text.length
      next = setRichLink(next, selection.start, end, href)
      transact(next, { ...selection, start: selection.start + text.length, end: selection.start + text.length })
    },
  }))
  useEffect(() => {
    if (value === lastSource.current && markdownContext === lastContext.current) return
    const next = parseRichText(value, markdownContext)
    lastContext.current = markdownContext
    if (props.readOnly) { live.current = next; setDoc(next); lastSource.current = value; return }
    // External updates join the document history; the buffer remains mounted.
    const selection = { ...range.current, start: Math.min(range.current.start, next.text.length), end: Math.min(range.current.end, next.text.length) }
    if (install(next, selection, false)) {
      lastSource.current = value
      history.current.record({ doc: next, ...selection }, false)
    }
  }, [value, markdownContext])
  useEffect(() => {
    if (pendingCaret.current && input.current) { select(pendingCaret.current); pendingCaret.current = null }
  }, [doc])
  const colors = noteInputMarkColors(t)
  const decorations: InputDecoration[] = doc.marks.map((m, i) => ({
    start: m.start, end: m.end,
    atomic: m.kind === 'marker' || m.kind === 'image' || (m.kind === 'link' && m.href?.startsWith('kybern://task/')),
    id: m.kind === 'link' ? `link:${i}` : m.kind === 'marker' ? `marker:${i}` : undefined,
    style: m.kind === 'bold' ? { fontWeight: 600 } : m.kind === 'italic' ? { fontStyle: 'italic' }
      : m.kind === 'link' ? { color: colors.accent, underline: true }
      : m.kind === 'code' ? { backgroundColor: colors.codeBackground, borderRadius: 5 }
      : m.kind === 'marker' ? { color: colors.textSecondary } : { color: colors.textSecondary },
  }))
  for (const line of doc.lines) {
    if (!/^#{1,6} /.test(line.prefix)) continue
    const end = doc.text.indexOf('\n', line.start)
    if ((end < 0 ? doc.text.length : end) > line.start) decorations.push({ start: line.start, end: end < 0 ? doc.text.length : end, style: { fontWeight: 600 } })
  }
  const rememberSelection = () => {
    const previous = range.current, current = read()
    if (previous.start !== current.start || previous.end !== current.end) pending.current = null
    if (previous.start !== current.start || previous.end !== current.end) history.current.selection(current.start, current.end, current.reversed)
  }
  const heading = !doc.text.includes('\n') ? doc.lines.find(l => l.start === 0 && /^#{1,3} /.test(l.prefix))?.prefix.trim().length : undefined
  return <DecoratedTextarea {...props} value={doc.text} decorations={decorations}
    ref={node => {
      input.current = node
      if (typeof nativeRef === 'function') nativeRef(node)
      else if (nativeRef) nativeRef.current = node
    }}
    interceptKeys={[...new Set([...(props.interceptKeys ?? []), 'z', 'y', 'b', 'i', 'backspace', 'delete'])]}
    style={{ ...props.style, ...(heading ? { fontSize: heading < 3 ? 18.3077 : props.style?.fontSize, fontWeight: 600 } : {}), ...(doc.fence ? { fontFamily: 'JetBrains Mono', backgroundColor: colors.codeBackground, borderRadius: 10, padding: 14 } : {}) }}
    onChange={event => {
      const text = event.value ?? ''
      if (replacement.current === text) { replacement.current = null; return }
      const previous = live.current, selection = read()
      const edit = textEdit(previous.text, text)
      let next: RichText
      try { next = updateRichText(previous, text) }
      catch (error) {
        // The native change has happened already. Restore that exact buffer
        // before reporting a nonrepresentable selection; never publish damage.
        if (input.current && !selection.composing) {
          replacement.current = previous.text
          nativeCapabilities(renderer).editInput(input.current.id, { start: 0, end: text.length, text: previous.text, expectedValue: text })
          const saved = history.current.entries[history.current.index]!
          select({ start: Math.min(saved.start, previous.text.length), end: Math.min(saved.end, previous.text.length), reversed: !!saved.reversed, composing: false })
          decoratedInputCapabilities(renderer).setInputDecorations(input.current.id, decorations, previous.text)
        }
        toast.error('Unable to edit this selection', { description: String(error) })
        return
      }
      if (pending.current !== null && edit.text.length) {
        const end = edit.start + edit.text.length
        for (const kind of ['bold', 'italic', 'strike', 'code'] as const) {
          const active = next.marks.some(m => m.kind === kind && m.start <= edit.start && m.end >= end)
          if (active !== pending.current.includes(kind)) next = toggleRichMark(next, edit.start, end, kind)
        }
      }
      const typed = selection.start === selection.end && Math.abs(text.length - previous.text.length) === 1 && edit.text !== '\n'
      if (selection.composing) {
        // Marked text belongs to the input method. Keep its native buffer and
        // visual state, but publish one committed document/history entry.
        composing.current = true; live.current = next; setDoc(next); return
      }
      const rule = !selection.composing && typed ? richInputRule(next, selection.start, !inlineOnly) : null
      if (rule && input.current) {
        // The event's buffer is already current; the transform is one history step.
        live.current = next
        if (install(rule.doc, { ...selection, start: rule.caret, end: rule.caret })) {
          history.current.record({ doc: rule.doc, start: rule.caret, end: rule.caret }, false)
          return
        }
      }
      publish(next)
      history.current.record({ doc: next, ...selection }, composing.current ? false : typed)
      composing.current = false
    }}
    onClick={event => {
      finishComposition(); rememberSelection()
      if (input.current && event.x != null && event.y != null) {
        const id = decoratedInputCapabilities(renderer).hitTestInputDecoration(input.current.id, event.x, event.y)
        const mark = id ? live.current.marks[Number(id.split(':')[1])] : null
        if (mark?.kind === 'link' && mark.href && (event.modifiers?.cmd || event.modifiers?.ctrl)) onOpenLink?.(mark.href)
        if (mark?.kind === 'marker' && mark.source && /\[[ xX]\]/.test(mark.source) && !props.readOnly && !read().composing) {
          transact(toggleRichChecklist(live.current, mark))
        }
      }
      props.onClick?.(event)
    }}
    onBlur={event => { finishComposition(); rememberSelection(); props.onBlur?.(event) }}
    onKeyUp={event => { finishComposition(); rememberSelection(); props.onKeyUp?.(event) }}
    onKeyDown={event => {
      const selection = read()
      const saved = history.current.entries[history.current.index]!
      if ((event as typeof event & { requestId?: number }).requestId != null && (saved.start !== selection.start || saved.end !== selection.end || saved.reversed !== selection.reversed)) history.current.selection(selection.start, selection.end, selection.reversed)
      if (!selection.composing && !props.readOnly && (event.modifiers?.cmd || event.modifiers?.ctrl) && !event.modifiers.alt) {
        if (event.key === 'z' || (event.key === 'y' && event.modifiers.ctrl)) {
          event.preventDefault()
          const entry = history.current.restore(event.key === 'y' || event.modifiers.shift ? 1 : -1)
          if (entry) { pending.current = null; install(entry.doc, { start: entry.start, end: entry.end, reversed: !!entry.reversed, composing: false }) }
          return
        }
        if (event.key === 'b' || event.key === 'i') { event.preventDefault(); mark(event.key === 'b' ? '**' : '*'); return }
      }
      props.onKeyDown?.(event)
    }}
  />
}
