// The task page edited in place, like the desktop's `.tk-dtitle`, `.tk-desc` and `.tk-ci`:
// the title, the description and each criterion are edited where they sit, in the reading
// layout. There is no edit mode, toolbar card, Done button or boxed field.
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useEffect, useMemo, useRef } from 'react'
import { RichEditor, type RichEditorHandle } from '../editor/RichEditor.tsx'
import type { ImageHome } from '../editor/images.ts'
import { getClient } from '../state.ts'
import { openLink } from '../notes/NoteEditor.tsx'
import { notesTokens } from '../notes/kit.tsx'
import { FONT_UI } from '../theme.ts'
import { ink, useTheme } from '../ui.tsx'
import { taskTyping } from './store.ts'

const TICK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M2.2 5.2 4.1 7.1 7.9 3" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** `.tk-dtitle`: 28/34 at 650, no box. Return commits and moves to the description; Escape puts the saved title back. */
export function TitleField({ value, saved, onChange, onCommit, onEnter }: { value: string; saved: string; onChange: (value: string) => void; onCommit: () => void; onEnter: () => void }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const escaped = useRef(false)
  const commit = () => { onChange(value.replace(/\s+/g, ' ').trim()); onCommit() }
  return (
    <textarea
      testId="task-title"
      aria-label="Title"
      placeholder="Task title"
      value={value}
      minRows={1}
      maxRows={6}
      interceptKeys={['enter', 'escape']}
      onFocus={() => { escaped.current = false; taskTyping(true) }}
      onBlur={() => { taskTyping(false); if (!escaped.current) commit() }}
      onChange={(e) => onChange((e.value ?? '').replace(/\n/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'enter') { e.preventDefault(); commit(); onEnter() }
        else if (e.key === 'escape') { e.preventDefault(); escaped.current = true; onChange(saved); renderer?.blur?.() }
      }}
      theme={{ text: t.text, caret: t.text }}
      style={{ width: '100%', padding: 0, fontFamily: FONT_UI, fontSize: 28, lineHeight: 34, fontWeight: 650, color: t.text, backgroundColor: 'transparent' }}
    />
  )
}

/** `.tk-desc .note-prose`: the shared editor at 15/24 in the task's 86% ink, edited where it is read
 * (desktop `NoteBody` variant `compact` inside `.tk-desc`). Images go to the environment that keeps the tasks. */
export function DescriptionEditor({ value, epoch, onChange, onCommit, onExit, onFocus, focus = false }: { value: string; epoch: number; onChange: (value: string) => void; onCommit: () => void; onExit: () => void; onFocus?: () => void; focus?: boolean }) {
  const t = useTheme()
  const editor = useRef<RichEditorHandle>(null)
  const images = useMemo<ImageHome>(() => ({ endpoint: () => getClient()?.endpoint ?? null }), [])
  useEffect(() => { if (focus) editor.current?.focus() }, [focus])
  return (
    <div testId="task-desc" style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
    <RichEditor
      ref={editor}
      testId="task-desc-input"
      aria-label="Description"
      value={value}
      epoch={epoch}
      variant="compact"
      size={15}
      lineHeight={24}
      color={ink(t, 0.86)}
      minHeight={24}
      images={images}
      placeholder="Add a description…"
      onOpenLink={openLink}
      interceptKeys={['escape']}
      onFocus={() => { taskTyping(true); onFocus?.() }}
      onBlur={() => { taskTyping(false); onCommit(); onExit() }}
      onKeyDown={(e) => { if (e.requestId != null && e.key === 'escape' && !e.defaultPrevented) { e.preventDefault(); onCommit(); onExit() } }}
      onChange={onChange}
    />
    </div>
  )
}

/** `.tk-ci`: a checkbox and the text on one line, no box around it. Return adds the next one; Backspace on an empty one removes it. */
export function CriterionRow({ index, text, checked, focusToken, onToggle, onText, onEnter, onBackspaceEmpty, onBlur, focusNow }: {
  index: number
  text: string
  checked: boolean
  focusToken: number
  focusNow: boolean
  onToggle: () => void
  onText: (text: string) => void
  onEnter: () => void
  onBackspaceEmpty: () => void
  onBlur: () => void
}) {
  const t = useTheme()
  const k = notesTokens(t)
  const { renderer } = useGpuix()
  const ref = useRef<PublicInstance>(null)
  // The row asked to take focus (after Return, Backspace or Add): once it is mounted.
  useEffect(() => { if (focusNow && ref.current) renderer?.focusElement?.(ref.current.id) }, [focusNow, focusToken])
  return (
    <div testId={`task-criterion-row-${index}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minHeight: 32, paddingTop: 4, paddingBottom: 4 }}>
      <div testId={`task-criterion-${index}`} role="checkbox" aria-checked={checked} aria-label={text || "Criterion"} tabIndex={0} onClick={onToggle} onKeyDown={(e) => { if (e.key === "space") { e.preventDefault(); onToggle() } }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, marginTop: 4, borderRadius: 4.5, flexShrink: 0, cursor: 'pointer', ...(checked ? { backgroundColor: k.checkOn } : { borderWidth: 1.5, borderColor: k.fg4, hover: { borderColor: k.fg3 } }) }}>
        {checked && <svg source={TICK} style={{ width: 10.5, height: 10.5, color: t.surface, pointerEvents: 'none' }} />}
      </div>
      <textarea
        ref={ref}
        testId={`task-criterion-text-${index}`}
        aria-label="Criterion"
        placeholder="Describe what done looks like"
        value={text}
        minRows={1}
        maxRows={8}
        interceptKeys={['enter', 'backspace']}
        onFocus={() => taskTyping(true)}
        onBlur={() => { taskTyping(false); onBlur() }}
        onChange={(e) => onText((e.value ?? '').replace(/\n/g, ' '))}
        onKeyDown={(e) => {
          if (e.key === 'enter') { e.preventDefault(); onEnter() }
          else if (e.key === 'backspace' && !text) { e.preventDefault(); onBackspaceEmpty() }
        }}
        theme={{ text: checked ? k.fg3 : k.fg1, caret: t.text }}
        style={{ flexGrow: 1, minWidth: 0, padding: 0, fontFamily: FONT_UI, fontSize: 15, lineHeight: 24, color: checked ? k.fg3 : k.fg1, backgroundColor: 'transparent' }}
      />
    </div>
  )
}
