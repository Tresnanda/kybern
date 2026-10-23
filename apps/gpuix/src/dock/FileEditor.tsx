// A file tab's editor (ADE-61): the native code editor (`native/code-editor.tsx`) over the file's buffer (`fileBuffers.ts`).
// Typing is native and immediate; the syntax document is reparsed on the napi worker pool one revision at a time, and the native
// side keeps the previous colours outside the edited span meanwhile. Tab/Enter/brackets go through `codeEditing.ts` as single
// `editInput` transactions (one undo step each), and ⌘F opens a find bar that selects matches in the editor.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { nativeCapabilities } from '../native/api.ts'
import { CodeEditorInput } from '../native/code-editor.tsx'
import { createSyntaxDocument, releaseSyntaxDocument, updateSyntaxDocument, type SyntaxDocument } from '../native/syntax.tsx'
import { textEdit } from '../notes/rich-text.ts'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { N } from '../nav/glyphs.ts'
import { codeKeyEdit, indentUnit, lineOf } from './codeEditing.ts'
import { getBuffer, setBufferText } from './fileBuffers.ts'

export interface FileEditorHandle {
  /** Show text that came from disk: one native edit of the changed span, so the caret and scroll stay (and ⌘Z undoes it). */
  replace(text: string): void
  /** ⌘F. */
  find(): void
  /** ⌘G / ⇧⌘G while the find bar has a query. */
  findNext(backwards: boolean): boolean
  /** The caret's 1-based line ("Open in…" opens the file there). */
  caretLine(): number
}

// Keys `codeKeyEdit` may take over; everything else goes straight to the native editor.
const INTERCEPT = ['tab', 'enter', 'backspace', '9', '0', '[', ']', "'", '`']
const MAX_MATCHES = 10_000
// While a reparse runs, edits wait for it: at most one parse in flight per editor.
export function FileEditor({ bufferKey, path, wrap, line, handle, onEdit }: { bufferKey: string; path: string; wrap: boolean; line?: number; handle: MutableRefObject<FileEditorHandle | null>; onEdit?: () => void }) {
  const renderer = useGpuixRequired()
  const t = useTheme()
  const theme = cachedMarkdownTheme(t)
  const [initial] = useState(() => getBuffer(bufferKey)?.text ?? '')
  const text = useRef(initial)
  const node = useRef<PublicInstance | null>(null)
  const unit = useMemo(() => indentUnit(initial), [initial])

  // Syntax: one document per mounted editor, updated with each edit's text.
  const [syntax, setSyntax] = useState<SyntaxDocument | null>(null)
  const doc = useRef<{ current: SyntaxDocument | null; busy: boolean; released: boolean }>({ current: null, busy: false, released: false })
  const reparse = () => {
    const state = doc.current
    if (!state.current || state.busy || state.released) return
    const sent = text.current
    if (sent.length > 2 * 1024 * 1024) return
    state.busy = true
    void updateSyntaxDocument(renderer, state.current.id, { expectedRevision: state.current.revision, text: sent }).then((next) => {
      if (state.released) return
      state.current = next
      setSyntax(next)
    }, () => {}).finally(() => {
      state.busy = false
      if (!state.released && text.current !== sent) reparse()
    })
  }
  useEffect(() => {
    const state = doc.current
    state.released = false
    void createSyntaxDocument(renderer, { text: text.current, path }).then((created) => {
      if (state.released) { releaseSyntaxDocument(renderer, created.id); return }
      state.current = created
      setSyntax(created)
      if (text.current !== initial) reparse()
    }, () => {})
    return () => {
      state.released = true
      if (state.current) releaseSyntaxDocument(renderer, state.current.id)
      state.current = null
    }
  }, [renderer, path])

  const changed = (value: string) => {
    if (value === text.current) return
    text.current = value
    setBufferText(bufferKey, value)
    reparse()
    onEdit?.()
  }
  const caps = () => nativeCapabilities(renderer)

  // `line` (a `path:line` link) brings that line into view, once per new value.
  // Without one, the caret starts on line 1 (the native editor would put it at the end of the file).
  const [reveal, setReveal] = useState(() => `${line ?? 1}:0`)
  const revealed = useRef(line)
  useEffect(() => { if (line && line !== revealed.current) { revealed.current = line; setReveal(`${line}:${Date.now()}`) } }, [line])

  // Find bar.
  const [find, setFind] = useState<{ query: string; index: number; count: number } | null>(null)
  const findField = useRef<PublicInstance | null>(null)
  const matches = (query: string) => {
    const out: number[] = []
    if (!query) return out
    const haystack = text.current.toLocaleLowerCase(), needle = query.toLocaleLowerCase()
    for (let at = haystack.indexOf(needle); at >= 0 && out.length < MAX_MATCHES; at = haystack.indexOf(needle, at + Math.max(1, needle.length))) out.push(at)
    return out
  }
  const select = (query: string, backwards: boolean, from?: number) => {
    const found = matches(query)
    if (!node.current || !found.length) { setFind({ query, index: -1, count: 0 }); return false }
    const selection = caps().getInputSelection(node.current.id)
    const origin = from ?? (backwards ? selection.start : selection.end)
    let index = -1
    if (backwards) { for (let i = found.length - 1; i >= 0; i--) if (found[i]! < origin) { index = i; break } } else index = found.findIndex((at) => at >= origin)
    if (index < 0) index = backwards ? found.length - 1 : 0
    const start = found[index]!
    try { caps().setInputSelection(node.current.id, start, start + query.length, false) } catch { /* typing raced the find */ }
    setFind({ query, index, count: found.length })
    return true
  }
  handle.current = {
    replace: (next) => {
      if (!node.current || next === text.current) return
      const id = node.current.id
      const selection = caps().getInputSelection(id)
      const edit = textEdit(text.current, next)
      try {
        caps().editInput(id, { ...edit, expectedValue: text.current })
        // Put the caret back where it was (shifted when the change was before it).
        const shift = (at: number) => at <= edit.start ? at : Math.max(edit.start, at + edit.text.length - (edit.end - edit.start))
        caps().setInputSelection(id, shift(selection.start), shift(selection.end), selection.reversed)
        text.current = next
        setBufferText(bufferKey, next)
        reparse()
      } catch { /* typing raced the reload: the next read retries */ }
    },
    find: () => {
      const selection = node.current ? caps().getInputSelection(node.current.id) : null
      const picked = selection && selection.end > selection.start && selection.end - selection.start < 200 ? text.current.slice(selection.start, selection.end) : ''
      setFind((previous) => ({ query: picked && !picked.includes('\n') ? picked : previous?.query ?? '', index: -1, count: 0 }))
      setTimeout(() => { if (findField.current) renderer.focusElement?.(findField.current.id) }, 0)
    },
    findNext: (backwards) => !!find?.query && select(find.query, backwards),
    caretLine: () => node.current ? lineOf(text.current, caps().getInputSelection(node.current.id).start) : 1,
  }
  const closeFind = () => { setFind(null); if (node.current) renderer.focusElement?.(node.current.id) }

  return <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    {find && <div testId="file-find-bar" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 40, paddingLeft: 8, paddingRight: 4, flexShrink: 0, borderBottomWidth: 0.6, borderColor: t.borderLight }}>
      <SearchField ref={findField} testId="file-find-field" label="Find in file" placeholder="Find" size="md" width={240} value={find.query}
        interceptKeys={['escape']}
        onChange={(query) => { if (!select(query, false, node.current ? caps().getInputSelection(node.current.id).start : 0)) setFind({ query, index: -1, count: 0 }) }}
        onSubmit={(event) => { select(find.query, !!event.modifiers?.shift) }}
        onKeyDown={(event) => { if (event.key === 'escape') { event.preventDefault(); closeFind() } }} />
      <Label color={t.textSecondary} size={12} style={{ minWidth: 72 }}>{!find.query ? '' : find.count ? `${find.index + 1} of ${find.count}${find.count >= MAX_MATCHES ? '+' : ''}` : 'No results'}</Label>
      <div style={{ flexGrow: 1 }} />
      <IconButton testId="file-find-previous" icon={N.arrowUp} label="Previous match" disabled={!find.count} onClick={() => select(find.query, true)} />
      <IconButton testId="file-find-next" icon={N.arrowDown} label="Next match" disabled={!find.count} onClick={() => select(find.query, false)} />
      <IconButton testId="file-find-close" icon={N.x} label="Close find" onClick={closeFind} />
    </div>}
    <CodeEditorInput
      ref={(element) => { node.current = element }}
      testId="file-editor"
      value={initial}
      theme={theme}
      syntaxDocument={syntax?.id}
      syntaxRevision={syntax?.revision}
      softWrap={wrap}
      showLineNumbers
      revealLine={reveal}
      interceptKeys={INTERCEPT}
      aria-label={`Edit ${path}`}
      onChange={(event) => changed(event.value ?? '')}
      onKeyDown={(event) => {
        const m = event.modifiers
        if (!event.key || !INTERCEPT.includes(event.key) || m?.cmd || m?.ctrl || m?.alt || !node.current) return
        const id = node.current.id
        const selection = caps().getInputSelection(id)
        if (selection.composing) return
        const edit = codeKeyEdit(text.current, selection, event.key, event.keyChar, !!m?.shift, unit, path)
        if (!edit) return
        try {
          if (edit.text || edit.start !== edit.end) caps().editInput(id, { start: edit.start, end: edit.end, text: edit.text, expectedValue: text.current })
          caps().setInputSelection(id, edit.caret, edit.caretEnd ?? edit.caret, false)
        } catch { return /* the native buffer moved on: the native default handles this key */ }
        event.preventDefault()
        changed(text.current.slice(0, edit.start) + edit.text + text.current.slice(edit.end))
      }}
      style={{ flexGrow: 1, minHeight: 0, minWidth: 0, height: '100%', paddingTop: 4, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 20, color: t.text }}
    />
  </div>
}
