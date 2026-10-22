import '../src/native/local-build.ts'
import { render, useGpuixRequired, type EventPayload } from '@gpuix/react'
import { dlopen, FFIType } from 'bun:ffi'
import { useEffect, useRef, useState } from 'react'
import { THEMES } from '../src/theme.ts'
import { ThemeProvider } from '../src/ui.tsx'
import { TokenTextarea, type TokenTextareaHandle } from '../src/composer/TokenTextarea.tsx'
import { RichEditor, type RichEditorHandle } from '../src/editor/RichEditor.tsx'

// Caps Lock typing through AppKit key events (caps-lock-input.m) into a plain input, the composer's
// TokenTextarea with the composer's interceptKeys, and the notes editor. `result` reports every
// field and the keyChar JS received.
const TITLE = 'Caps Lock lab'
const CAPS = 1, SHIFT = 2, SLOW = 4
const keys = dlopen(new URL('./build/caps-lock-input.dylib', import.meta.url).pathname, {
  kybern_caps_type: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.void },
}).symbols
const cstring = (text: string) => Buffer.from(`${text}\0`)
const COMPOSER_KEYS = ['up', 'down', 'left', 'right', 'home', 'end', 'enter', 'tab', 'escape', 'v']
type Field = 'plain' | 'composer' | 'note'
const STEPS: { name: string; field: Field; keys: string; flags: number }[] = [
  { name: 'plain', field: 'plain', keys: 'caps lock on', flags: CAPS | SLOW },
  { name: 'composer-slow', field: 'composer', keys: 'caps lock vxyz', flags: CAPS | SLOW },
  { name: 'composer-burst', field: 'composer', keys: 'caps lock vxyz', flags: CAPS },
  { name: 'composer-shift', field: 'composer', keys: 'cab', flags: SHIFT },
  { name: 'composer-off', field: 'composer', keys: 'cab', flags: 0 },
  { name: 'note-burst', field: 'note', keys: 'ab\x1bcd', flags: CAPS },
]
const t = THEMES.dark

function Lab() {
  const renderer = useGpuixRequired()
  const [plain, setPlain] = useState('')
  const [composer, setComposer] = useState('')
  const [note, setNote] = useState({ value: '', epoch: 0 })
  // Read back through refs: a step's report must not depend on which render's handler runs.
  const values = useRef({ plain: '', composer: '', note: '' })
  const [result, setResult] = useState('')
  const step = useRef(0), keyChars = useRef<string[]>([])
  const nodes = useRef<Partial<Record<Field, { id: number } | null>>>({})
  const editor = useRef<RichEditorHandle | null>(null)
  const tokens = useRef<TokenTextareaHandle | null>(null)
  // Published on a timer: an automation key on the root to ask for it would take focus mid-typing.
  useEffect(() => {
    const timer = setInterval(() => setResult(JSON.stringify({ step: step.current, ...values.current, keyChars: keyChars.current })), 50)
    return () => clearInterval(timer)
  }, [])
  // `n` clears the fields; `t` focuses the step's field and types its keys.
  const next = () => {
    const current = STEPS[step.current]
    if (!current) return
    keyChars.current = []
    values.current = { plain: '', composer: '', note: '' }
    setPlain(''); setComposer(''); setNote(n => ({ value: '', epoch: n.epoch + 1 }))
  }
  // The automation key that triggers this leaves focus on the root, so focus the field again and
  // send the AppKit events once that focus has applied.
  const type = () => {
    const current = STEPS[step.current++]
    if (!current) return
    if (current.field === 'note') editor.current?.focus('start')
    else if (nodes.current[current.field]) renderer.focusElement?.(nodes.current[current.field]!.id)
    setTimeout(() => keys.kybern_caps_type(cstring(TITLE), cstring(current.keys), current.flags), 150)
  }
  return <ThemeProvider>
    <div testId="ready" tabIndex={0} onKeyDown={(e: EventPayload) => { if (e.key === 'n') next(); if (e.key === 't') type() }}
      style={{ width: '100%', height: '100%', backgroundColor: t.surface, padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <input testId="plain" ref={(node: { id: number } | null) => { nodes.current.plain = node }} value={plain} onChange={e => { values.current.plain = e.value ?? ''; setPlain(values.current.plain) }}
        style={{ width: 400, height: 32, color: t.text, fontSize: 14, backgroundColor: t.hover }} />
      <div style={{ width: 400, backgroundColor: t.hover }}>
        <TokenTextarea testId="composer" editorRef={tokens} references={[]} nativeRef={(node: { id: number } | null) => { nodes.current.composer = node }}
          interceptKeys={COMPOSER_KEYS} value={composer} onChange={e => { values.current.composer = e.value ?? ''; setComposer(values.current.composer) }}
          onKeyDown={e => { if (e.keyChar) keyChars.current.push(e.keyChar) }}
          minRows={2} maxRows={4} style={{ width: '100%', fontSize: 14, color: t.text }} />
      </div>
      <div style={{ width: 400, minHeight: 80, backgroundColor: t.hover }}>
        <RichEditor ref={editor} value={note.value} epoch={note.epoch} variant="compact" interceptKeys={['escape']}
          onChange={markdown => { values.current.note = markdown }} />
      </div>
      <text testId="result" style={{ color: t.text, fontSize: 12 }}>{result}</text>
    </div>
  </ThemeProvider>
}
render(<Lab />, { title: TITLE, width: 480, height: 420, focus: false })
