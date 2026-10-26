// Questions and input forms in the request family: blocking questions from a harness (`UserInputPanel`), the form-shaped
// requests (`ui_select`, `ui_confirm`, `ui_input`, `ui_editor`, MCP elicitation) and non-blocking async questions.
// A question is the card's title, with the rest of its Markdown as a body. Its options are the family's numbered rows; the
// last row, "Something else…", becomes the answer field in place. The focused option's preview sits beside the rows when the
// card is at least 640 pt wide, else under the focused row. Attach adds an image, a window capture or a file to the answer (the
// "Point for me" kinds, `attach.ts`), which the daemon passes to the agent as paths. Spec: `.kybern-artifacts/ade-69-71/qcard/`.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { useGpuixRequired } from '@gpuix/react'
import { array, normalizedResponse, questionResponse, questionsFor, record, string, type QuestionOption } from '../../../../packages/kybern-client/src/userInput.ts'
import type { ApprovalRequest, AsyncQuestionRequest, QuestionDeadline, ThreadId, UserInputAttachment } from '../../../../packages/kybern-client/src/types.ts'
import { defaultOption, questionDeadline } from '../../../../packages/kybern-client/src/requestCards.ts'
import { answerQuestions, errorText, respondApproval } from '../transcript/store.ts'
import { T } from '../transcript/glyphs.ts'
import { Button } from '../kit/Button.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { TextArea } from '../kit/TextArea.tsx'
import { TextField } from '../kit/Field.tsx'
import { Label } from '../ui.tsx'
import { TokenChip } from '../kit/TokenChip.tsx'
import { Icon, ICONS } from '../icons.tsx'
import { G } from '../composer/glyphs.ts'
import { Menu, MenuItem, Tip } from '../nav/overlay.tsx'
import { SCALE } from '../motion/kit.tsx'
import { pressTransform } from '../motion/press.ts'
import { EDGE_FADE } from '../native/local-build.ts'
import type { Theme } from '../theme.ts'
import { githubSyntax, markdownTheme, syntaxProfile } from '../transcript/kit.tsx'
import { captureWindow, uploadImage, uploadImageFile } from './attach.ts'
import { openScreenRecordingSettings, screenRecordingGranted } from '../pick/screenRecording.ts'
import { CardShell, DigitKey, ExpandLink, HintText, Hints, Kbd, OptionList, OptionRow, RequestHeader, useCardTokens, useExpandShortcut, Well } from './Card.tsx'
import { focusCard } from './ui.ts'
import { keyboardAnswer } from './Panel.tsx'
import { DeadlineHint, usePauseController } from './Deadline.tsx'
import { actOnRequest, refreshProgress, useRequestProgress } from './progress.ts'
import { isPrimary } from '../platform/keys.ts'

/** "Wait for me": a quiet pill after the countdown; the question then waits with no deadline (`requests.act hold`). Gone once held. */
function WaitForMe({ approvalId, disabled }: { approvalId: string; disabled: boolean }) {
  const k = useCardTokens()
  const phase = useRequestProgress(approvalId)?.phase
  const [busy, setBusy] = useState(false)
  if (phase === 'held') return null
  const off = disabled || busy
  const hold = () => { if (off) return; setBusy(true); void actOnRequest(approvalId, 'hold').catch(() => {}).finally(() => setBusy(false)) }
  return (
    <div testId="question-hold" role="button" aria-label="Wait for me" aria-disabled={off || undefined} tabIndex={off ? -1 : 0}
      onClick={hold} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') { keyboardAnswer(); hold() } }}
      paintTransform={pressTransform(!off, SCALE.tiny)}
      style={{ display: 'flex', alignItems: 'center', height: 22, paddingLeft: 7, paddingRight: 7, marginLeft: 2, borderRadius: 7, flexShrink: 0, cursor: off ? 'default' : 'pointer', opacity: off ? 0.5 : 1, backgroundColor: k.chipBg,
        ...(off ? {} : { hover: { backgroundColor: k.c.ink(0.1) }, focusVisible: { outlineWidth: 2, outlineColor: k.c.focus, outlineOffset: 0 } }) }}>
      <Label color={k.t.textSecondary} size={12} lineHeight={16} weight={500}>Wait for me</Label>
    </div>
  )
}

interface Spec {
  id: string
  /** The question. Markdown. */
  title: string
  /** A short label ("Layout"): the step's name with several questions, and the rows' accessible name. */
  header?: string
  options: QuestionOption[]
  multiple: boolean
  /** The last row is a free answer. */
  custom: boolean
  secret: boolean
  /** Attach is offered: the harness takes images and files with the answer. */
  attachments?: boolean
}

/** An attachment the card holds, with what its chip shows. */
type Held = UserInputAttachment & { key: string }

const plain = (label: string) => [{ text: label }]

/** A line that starts a Markdown block (a list, heading, quote, table or fence), never part of the title. */
const BLOCK = /^\s*([-+*]\s|\d+[.)]\s|#|>|\||```|~~~)/
/** Inline Markdown as the plain words it shows. */
const plainText = (md: string) => md
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
  .replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1$2')
  .replace(/(^|[^\w_])_([^_\n]+)_/g, '$1$2')
  .trim()
/** The longest first paragraph that still reads as a title; anything longer becomes the body under the header word. */
const TITLE_MAX = 200

/** The card title is the question's first paragraph as plain text; the body is the Markdown after it. A question that opens
 *  with a block (a list, a fence) or a very long paragraph keeps all of it as the body, under its header word. */
export function splitQuestion(question: string, header?: string): { title: string; body: string } {
  const text = question.trim()
  const lines = text.split('\n')
  const head: string[] = []
  let i = 0
  while (i < lines.length && lines[i]!.trim() && !BLOCK.test(lines[i]!)) head.push(lines[i++]!.trim())
  const title = plainText(head.join(' '))
  if (!title || title.length > TITLE_MAX) return { title: header?.trim() || 'Question', body: text }
  return { title, body: lines.slice(i).join('\n').trim() }
}

/** Most attachments on one answer (the daemon's `MAX_ANSWER_ATTACHMENTS`). */
const MAX_ATTACHMENTS = 6
/** A card at least this wide shows the preview beside the rows (A); narrower ones open it under the focused row (B). */
export const SIDE_PREVIEW_MIN_WIDTH = 640
/** Preview lines shown under a row before "Show all N lines". */
const PREVIEW_LINES = 6
/** The preview's code line (Menlo 11.5/17) and the well's vertical padding. */
const CODE_LINE = 17
const WELL_PAD = 8

/** The Markdown themes of the card: the body (13/19 `text2`, inline code on `ink 6%` with 1/3 padding, radius 4) and the
 *  previews (prose 12.5/18; code 11.5/17 with no header and no block fill, the transcript's highlighter for the fence language). */
type QuestionMarkdown = 'body' | 'prose' | `code:${string}`
const themes = new WeakMap<Theme, Map<string, ReturnType<typeof markdownTheme>>>()
function questionMarkdown(t: Theme, chip: string, kind: QuestionMarkdown) {
  let cache = themes.get(t)
  if (!cache) themes.set(t, (cache = new Map()))
  const key = `${kind}|${chip}`
  const hit = cache.get(key)
  if (hit) return hit
  const base = markdownTheme(t)
  const body = kind === 'body'
  const size = body ? 13 : 12.5
  const theme = {
    ...base,
    text: body ? t.textSecondary : t.text,
    codeText: t.text,
    codeWash: chip,
    syntax: kind.startsWith('code:') ? githubSyntax(t.variant, syntaxProfile(kind.slice(5))) : base.syntax,
    bg: 'rgba(0, 0, 0, 0)',
    markdown: { ...base.markdown, inlineCodePaddingX: 3, inlineCodePaddingY: 1, inlineCodeSizeRatio: 11.5 / size, codeHeader: false, codeWrap: true, codeBackground: 'rgba(0, 0, 0, 0)' },
    metrics: { ...base.metrics, mdTextSize: size, mdLineHeight: body ? 19 : 18, mdBlockGap: 8, mdInlineCodeRadius: 4, mdCodePaddingX: 0, mdCodePaddingY: 0, codeTextSize: 11.5, codeLineHeight: CODE_LINE },
  }
  cache.set(key, theme)
  return theme
}

/** The question's body under the title, bounded: a long body scrolls inside the card. */
function QuestionBody({ text }: { text: string }) {
  const k = useCardTokens()
  return (
    <div testId="question-body" style={{ display: 'flex', flexDirection: 'column', marginLeft: 34, marginTop: 2, maxHeight: 220, overflowY: 'scroll', minWidth: 0 }}>
      <markdown source={text} theme={questionMarkdown(k.t, k.chipBg, 'body')} style={{ color: k.t.textSecondary, userSelect: 'text' }} />
    </div>
  )
}

/** A preview as the well draws it: one fenced block is code (its language labelled), anything else is prose. */
const FENCE = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n?\1\s*$/
function readPreview(preview: string): { kind: 'code'; language: string; lines: string[] } | { kind: 'prose'; lines: string[] } {
  const fence = FENCE.exec(preview.trim())
  if (fence) return { kind: 'code', language: fence[2]!.trim().split(/\s+/)[0] ?? '', lines: fence[3]!.split('\n') }
  return { kind: 'prose', lines: preview.trim().split('\n') }
}
const previewSource = (p: ReturnType<typeof readPreview>, lines: string[]) => p.kind === 'code' ? `\`\`\`${p.language}\n${lines.join('\n')}\n\`\`\`` : lines.join('\n')

/** The focused row's preview. `inline` (B): under the row on the text column, six lines then "Show all N lines" (⌘E). `pane` (A):
 *  beside the rows at their height (4 to 12 lines), scrolling inside, and saying so when the focused row has none. */
function PreviewWell({ option, own, layout, expanded, onToggle }: { option: QuestionOption | undefined; /** The free answer is focused. */ own: boolean; layout: 'inline' | 'pane'; expanded: boolean; onToggle: () => void }) {
  const k = useCardTokens()
  const preview = option?.preview ? readPreview(option.preview) : null
  const clamped = layout === 'inline' && !!preview && !expanded && preview.lines.length > PREVIEW_LINES
  useExpandShortcut(layout === 'inline' && !!preview && preview.lines.length > PREVIEW_LINES, onToggle)
  const code = preview?.kind === 'code'
  const shell = { borderRadius: 9, backgroundColor: k.wellFill, boxShadow: [{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 1, color: k.wellRim, inset: true }] }
  const pad = { paddingLeft: 10, paddingRight: code ? 40 : 12, paddingTop: WELL_PAD, paddingBottom: WELL_PAD }
  const language = code && preview.language
    ? <Label color={k.t.textTertiary} size={11} lineHeight={16} weight={500} style={{ position: 'absolute', top: 7, right: 10 } as never}>{preview.language}</Label>
    : null
  const body = preview && (
    <markdown source={previewSource(preview, clamped ? preview.lines.slice(0, PREVIEW_LINES) : preview.lines)} theme={questionMarkdown(k.t, k.chipBg, code ? `code:${preview.language}` : 'prose')} style={{ color: k.t.text, userSelect: 'text' }} />
  )
  if (layout === 'pane') {
    return (
      <div testId="question-preview" style={{ position: 'relative', display: 'flex', flexGrow: 1.05, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 4 * CODE_LINE + 2 * WELL_PAD, maxHeight: 12 * CODE_LINE + 2 * WELL_PAD, ...shell }}>
        {preview
          ? <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', overflowY: 'scroll', minWidth: 0, ...pad }}>{body}</div>
          : (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 12, paddingRight: 12 }}>
              <Label color={k.t.textTertiary} size={12} lineHeight={16}>{own ? 'Your own answer has no preview' : 'No preview'}</Label>
            </div>
          )}
        {language}
      </div>
    )
  }
  if (!preview) return null
  return (
    <div testId="question-preview" style={{ position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0, marginTop: 2, marginLeft: 42, marginRight: 8, marginBottom: 6, ...pad, ...shell }}>
      <div edgeFade={clamped && EDGE_FADE ? { bottom: 26 } : undefined} style={{ display: 'flex', flexDirection: 'column', minWidth: 0, ...(expanded ? { maxHeight: 220, overflowY: 'scroll' } : {}) }}>{body}</div>
      {(clamped || (expanded && preview.lines.length > PREVIEW_LINES)) && <ExpandLink testId="question-preview-expand" expanded={expanded} label={`Show all ${preview.lines.length} lines`} onClick={onToggle} />}
      {language}
    </div>
  )
}

/** Attach: an image file, a window capture or a file, the "Point for me" kinds. Uploads happen here; the card holds the result. */
function AttachMenu({ disabled, full, onAdd, onError, onTouch }: { disabled: boolean; /** Six held already. */ full: boolean; onAdd: (item: UserInputAttachment) => void; onError: (message: string) => void; onTouch: () => void }) {
  const renderer = useGpuixRequired()
  const k = useCardTokens()
  const [busy, setBusy] = useState(false)
  const child = useRef<ChildProcess | null>(null)
  useEffect(() => () => { child.current?.kill() }, [])
  const run = (work: () => Promise<void>) => {
    onTouch()
    setBusy(true)
    onError('')
    void work().catch((e) => onError(`Unable to attach that. ${errorText(e).replace(/\.?$/, '.')}`)).finally(() => setBusy(false))
  }
  const image = () => run(async () => {
    const path = (await renderer.promptForPaths?.({ files: true, multiple: false, prompt: 'Attach' }))?.[0]
    if (!path) return
    const uploaded = await uploadImageFile(path)
    onAdd({ kind: 'image', name: uploaded.name, asset_id: uploaded.assetId })
  })
  const window = () => {
    if (screenRecordingGranted() === false) {
      onError('Screen Recording is off for Kybern. Turn it on in System Settings, then capture again.')
      openScreenRecordingSettings()
      return
    }
    run(async () => {
      const bytes = await captureWindow((proc) => { child.current = proc })
      if (!bytes) return
      const uploaded = await uploadImage('window.png', 'image/png', bytes)
      onAdd({ kind: 'window', name: 'Window capture', asset_id: uploaded.assetId })
    })
  }
  const file = () => run(async () => {
    const path = (await renderer.promptForPaths?.({ files: true, multiple: false, prompt: 'Attach' }))?.[0]
    if (path) onAdd({ kind: 'file', name: basename(path), path })
  })
  const off = disabled || busy || full
  const label = full ? `Up to ${MAX_ATTACHMENTS} attachments` : 'Attach an image, window or file'
  const button = (open: boolean) => (
    <Tip label={label} side="top" size={28} disabled={open}>
      <IconButton icon={G.paperclip} glyph={15} label={label} active={open} disabled={off} tabIndex={-1} testId="question-attach">
        {busy ? <Spinner size={14} color={k.t.textSecondary} /> : undefined}
      </IconButton>
    </Tip>
  )
  // The menu wrapper is the focus stop and opens on a click, Return, Space or ↓; a full or busy Attach is the button alone.
  if (off) return button(false)
  return (
    <Menu testId="question-attach-menu" side="top" align="end" minWidth={200} fit="switch" rootStyle={{ flexGrow: 0, flexShrink: 0 }} trigger={button}>
      <MenuItem id="image" icon={G.image} label="Image…" testId="question-attach-image" onSelect={image} />
      {process.platform === 'darwin' && <MenuItem id="window" icon={ICONS.window} label="Window capture…" testId="question-attach-window" onSelect={window} />}
      <MenuItem id="file" icon={G.file} label="File…" testId="question-attach-file" onSelect={file} />
    </Menu>
  )
}

/** A failed answer: what went wrong, then what to do. */
const sendFailed = (e: unknown) => `Unable to send your answer: ${errorText(e).replace(/\.$/, '')}. Check it and try again.`

/** Rough widths of the footer's parts (GPUIX cannot measure before it paints): the hint drops "↑ ↓ to move" first, then goes
 *  entirely, before any action button would have to shrink. */
const W = { attach: 28, decline: 60, back: 62, gap: 6, primary: { Send: 64, Next: 62, Review: 78, 'Sending…': 92 } as Record<string, number> }
const HINT = { move: 100, choose: 116, toggle: 106, send: 76, back: 196, newline: 124 }

/** One step per question, then a review with several. Rows are picked with digits, ↑ ↓ or a click; Return runs the primary. */
function QuestionCard({ specs, count, busy, error, onSend, onDecline, deadline }: { specs: Spec[]; count: number; busy: boolean; error: string; onSend: (answers: string[][], attachments: UserInputAttachment[][]) => void; onDecline?: () => void; /** A daemon question that answers itself with its defaults. */ deadline?: { approvalId: string; deadline: QuestionDeadline } }) {
  const k = useCardTokens()
  const [attached, setAttached] = useState<Record<string, Held[]>>({})
  const [attachError, setAttachError] = useState('')
  const [step, setStep] = useState(0)
  const defaults = (q: Spec) => defaultOption(deadline?.deadline ?? null, q)
  const hasField = (q: Spec) => q.custom && !q.secret
  /** The row a question opens on: its default, else the first. In single choice that row is also picked, so Return sends it. */
  const arrival = (q: Spec) => Math.max(0, defaults(q))
  const [selected, setSelected] = useState<Record<string, string[]>>(() => Object.fromEntries(specs.flatMap((q, i) => !q.multiple && q.options.length && (i === 0 || defaults(q) >= 0) ? [[q.id, [q.options[arrival(q)]!.label]]] : [])))
  const deadlinePhase = useRequestProgress(deadline?.approvalId ?? '')?.phase
  const pause = usePauseController(deadline?.approvalId ?? '', !!deadline && deadlinePhase !== 'held')
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [cursor, setCursor] = useState(() => specs[0] ? arrival(specs[0]) : 0)
  // A question with no options is its field, open from the start.
  const [editing, setEditing] = useState(() => !!specs[0] && hasField(specs[0]) && !specs[0].options.length)
  const [expanded, setExpanded] = useState(false)
  const [width, setWidth] = useState(0)
  // The focus ring shows while the card holds keyboard focus, and hides after a click until the next key.
  const [focused, setFocused] = useState(false)
  const [pointer, setPointer] = useState(false)
  const reviewing = step === specs.length
  const q = specs[step]
  const draft = (s: Spec) => custom[s.id]?.trim() ?? ''
  const answersFor = (s: Spec): string[] => {
    const picked = selected[s.id] ?? []
    if (s.multiple) return draft(s) ? [...picked, draft(s)] : picked
    return picked.length ? picked : draft(s) ? [draft(s)] : []
  }
  const attachmentsFor = (s: Spec): Held[] => attached[s.id] ?? []
  // A question that takes a written answer may be answered with attachments alone ("which looks right?" → a screenshot).
  const answered = (s: Spec) => answersFor(s).length > 0 || (s.custom && attachmentsFor(s).length > 0)
  const ready = specs.every(answered)
  const canContinue = reviewing ? ready : !!q && answered(q)
  const send = () => onSend(specs.map(answersFor), specs.map((s) => attachmentsFor(s).map(({ key: _key, ...item }) => item)))
  const rows = q?.options.length ?? 0
  const fieldRow = q && hasField(q) ? rows : -1
  const total = rows + (fieldRow >= 0 ? 1 : 0)
  // One question sends straight away; several go step by step to a review.
  const direct = specs.length === 1
  const last = step === specs.length - 1
  const primary = busy ? 'Sending…' : reviewing || direct ? 'Send' : last ? 'Review' : 'Next'
  const goto = (next: number) => {
    setStep(next)
    setExpanded(false)
    const s = specs[next]
    if (!s) { setEditing(false); return }
    const picked = selected[s.id] ?? []
    const at = picked.length ? Math.max(0, s.options.findIndex((o) => o.label === picked[0])) : !s.multiple && draft(s) && hasField(s) ? s.options.length : arrival(s)
    setCursor(at)
    if (!s.multiple && !picked.length && !draft(s) && s.options[at]) setSelected((current) => ({ ...current, [s.id]: [s.options[at]!.label] }))
    setEditing(hasField(s) && !s.options.length)
  }
  const next = () => {
    if (busy || !canContinue) return
    if (reviewing || direct) send()
    else goto(step + 1)
  }
  const openField = () => {
    if (!q || fieldRow < 0) return
    setCursor(fieldRow)
    setEditing(true)
    // In single choice the typed answer replaces the picked one.
    if (!q.multiple) setSelected((current) => ({ ...current, [q.id]: [] }))
  }
  const closeField = () => {
    if (!q?.options.length) return
    setEditing(false)
    setPointer(false)
    focusCard()
  }
  /** `move`: ↑ ↓ (single choice follows the cursor); `choose`: a digit, Space or a click (multi-select toggles, the free row opens). */
  const choose = (index: number, how: 'move' | 'choose') => {
    if (!q || busy) return
    setCursor(index)
    setExpanded(false)
    if (index === fieldRow) {
      if (how === 'choose') openField()
      else if (!q.multiple) setSelected((current) => ({ ...current, [q.id]: [] }))
      return
    }
    setEditing(false)
    const option = q.options[index]
    if (!option) return
    const current = selected[q.id] ?? []
    if (!q.multiple) setSelected({ ...selected, [q.id]: [option.label] })
    else if (how === 'choose') setSelected({ ...selected, [q.id]: current.includes(option.label) ? current.filter((v) => v !== option.label) : [...current, option.label] })
  }
  const onKey = (e: { key?: string; modifiers?: { cmd?: boolean } }): boolean => {
    if (busy || reviewing || isPrimary(e.modifiers) || !q) return false
    const key = e.key ?? ''
    if (/^([1-9]|up|down|space|enter)$/.test(key) || key.length === 1) pause.touch()
    setPointer(false)
    if (/^[1-9]$/.test(key)) { const i = Number(key) - 1; if (i >= total) return false; keyboardAnswer(); choose(i, 'choose'); return true }
    if (key === 'up' || key === 'down') {
      if (total) choose(Math.min(total - 1, Math.max(0, cursor + (key === 'down' ? 1 : -1))), 'move')
      return true
    }
    if (key === 'space' && q.multiple) { choose(cursor, 'choose'); return true }
    if (key === 'enter') {
      keyboardAnswer()
      if (cursor === fieldRow && !draft(q)) openField()
      else if (canContinue) next()
      else if (cursor < rows) choose(cursor, 'choose')
      return true
    }
    // Typing on the free row starts the answer there.
    if (cursor === fieldRow && key.length === 1 && !/\d/.test(key)) { setCustom({ ...custom, [q.id]: (custom[q.id] ?? '') + key }); openField(); return true }
    return false
  }
  const attach = (s: Spec) => (item: UserInputAttachment) => {
    pause.touch()
    setAttached((current) => ({ ...current, [s.id]: [...(current[s.id] ?? []), { ...item, key: crypto.randomUUID() }].slice(0, MAX_ATTACHMENTS) }))
  }
  const detach = (s: Spec, key: string) => setAttached((current) => ({ ...current, [s.id]: (current[s.id] ?? []).filter((item) => item.key !== key) }))
  const split = q ? splitQuestion(q.title, q.header) : { title: '', body: '' }
  const body = q?.multiple ? (split.body ? `${split.body}\n\nSelect all that apply.` : 'Select all that apply.') : split.body
  const previews = !reviewing && !!q?.options.some((option) => option.preview)
  const wide = previews && width >= SIDE_PREVIEW_MIN_WIDTH
  const canAttach = !reviewing && !!q?.attachments && !q.secret
  const held = q ? attachmentsFor(q) : []
  const ring = focused && !pointer && !busy
  const toggleExpanded = () => setExpanded((open) => !open)

  // The footer: hints on the lead edge, actions on the trailing edge; the hint gives way before a button would shrink.
  const actionsWidth = (canAttach ? W.attach + W.gap : 0) + (onDecline ? W.decline + W.gap : 0) + (step > 0 ? W.back + W.gap : 0) + (W.primary[primary] ?? 80)
  const room = width ? width - 32 - actionsWidth - W.gap : Infinity
  const fieldHint = !q?.options.length
    ? { full: HINT.send + HINT.newline, short: HINT.send }
    : { full: HINT.send + HINT.back, short: HINT.send }
  const keysHint = q?.multiple ? { full: HINT.move + HINT.toggle, short: HINT.toggle } : { full: HINT.move + HINT.choose, short: HINT.choose }
  const fit = (need: { full: number; short: number }) => room >= need.full ? 'full' : room >= need.short ? 'short' : 'none'
  const enterHint = direct || reviewing ? 'to send' : last ? 'to review' : 'for the next question'
  let hint: ReactNode
  if (reviewing) hint = <HintText>Check your answers before sending.</HintText>
  else if (deadline) hint = <><DeadlineHint approvalId={deadline.approvalId} deadline={deadline.deadline} chosen={specs.length === 1 && defaults(specs[0]!) >= 0 ? specs[0]!.options[defaults(specs[0]!)]!.label : null} /><WaitForMe approvalId={deadline.approvalId} disabled={busy} /></>
  else if (editing) {
    const shown = fit(fieldHint)
    hint = shown === 'none' ? null : <>
      <Kbd keys={['↵']} /><HintText>{enterHint}</HintText>
      {shown === 'full' && (q?.options.length
        ? <><HintText>·</HintText><Kbd keys={['esc']} /><HintText>to go back to the options</HintText></>
        : <><HintText>·</HintText><Kbd keys={['⇧', '↵']} /><HintText>for a new line</HintText></>)}
    </>
  } else if (total > 1) {
    const shown = fit(keysHint)
    hint = shown === 'none' ? null : <>
      {shown === 'full' && <><Kbd keys={['↑', '↓']} /><HintText>to move</HintText><HintText>·</HintText></>}
      {q?.multiple
        ? <><Kbd keys={['space']} /><HintText>to toggle</HintText></>
        : <><Kbd keys={['1']} /><HintText>–</HintText><Kbd keys={[String(total)]} /><HintText>to choose</HintText></>}
    </>
  } else hint = <HintText>The agent is waiting for your answer.</HintText>

  const field = q && fieldRow >= 0 && (
    <TextArea
      label="Your answer" testId="question-answer" bare autoFocus value={custom[q.id] ?? ''} placeholder="Type your answer" minRows={1} maxRows={4}
      style={{ fontSize: 13, fontWeight: 400 }} disabled={busy}
      interceptKeys={['enter', 'escape']}
      onChange={(v) => { pause.touch(); setCustom((current) => ({ ...current, [q.id]: v })) }}
      onKeyDown={(e) => {
        if (e.key === 'escape') { e.preventDefault(); closeField() }
        else if (e.key === 'enter' && !e.modifiers?.shift) { e.preventDefault(); keyboardAnswer(); next() }
      }}
    />
  )
  const preview = (layout: 'inline' | 'pane') => q && (
    <PreviewWell key="preview" layout={layout} option={cursor < rows ? q.options[cursor] : undefined} own={cursor === fieldRow} expanded={expanded} onToggle={toggleExpanded} />
  )
  const list = q && (
    <OptionList label={q.header || split.title} bleed={wide ? 'start' : 'both'} style={wide ? { marginTop: 0, flexGrow: 1, flexShrink: 1, flexBasis: 0 } : undefined}>
      {q.options.flatMap((option, i) => {
        const picked = (selected[q.id] ?? []).includes(option.label)
        const row = (
          <OptionRow
            key={option.label} n={q.multiple ? undefined : i + 1} label={plain(option.label)} description={option.description} testId={`question-option-${i}`}
            tag={deadline && defaults(q) === i ? 'Default' : undefined}
            role={q.multiple ? 'checkbox' : 'radio'} highlighted={!q.multiple && picked} checked={q.multiple && picked}
            cursor={q.multiple && cursor === i} focused={ring && cursor === i} disabled={busy} dim={busy}
            lead={q.multiple ? <Checkbox checked={picked} aria-label={option.label} style={{ pointerEvents: 'none' }} /> : undefined}
            onClick={() => choose(i, 'choose')}
          />
        )
        return previews && !wide && cursor === i ? [row, preview('inline')] : [row]
      })}
      {fieldRow >= 0 && (
        <OptionRow
          key="free" n={q.multiple ? undefined : fieldRow + 1} testId="question-row-custom" role={q.multiple ? 'checkbox' : 'radio'}
          label={plain(draft(q) ? custom[q.id]!.trim() : 'Something else…')} muted
          highlighted={!q.multiple && !editing && !(selected[q.id] ?? []).length && !!draft(q)} checked={q.multiple && !!draft(q)}
          cursor={q.multiple && cursor === fieldRow && !editing} focused={ring && cursor === fieldRow && !editing} disabled={busy} dim={busy}
          lead={q.multiple ? <DigitKey n="+" highlighted={editing || !!draft(q)} /> : undefined}
          field={editing ? field : undefined}
          onClick={() => choose(fieldRow, 'choose')}
        />
      )}
    </OptionList>
  )
  return (
    <CardShell
      testId="question-panel" onKey={onKey} onWidth={setWidth} onFocusChange={setFocused} onPointerDown={() => setPointer(true)}
      {...(deadline ? { onPointerEnter: () => pause.hover(true), onPointerLeave: () => pause.hover(false), onFocusIn: pause.touch } : {})}
    >
      <RequestHeader
        glyph={T.question} wrap
        title={reviewing ? 'Review your answers' : split.title}
        badge={count > 1 ? `${count} requests` : undefined}
        aside={specs.length < 2 ? undefined : reviewing ? `${specs.length} answered` : (
          <div testId="question-step" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 20, flexShrink: 0 }}>
            {q?.header && <><Label color={k.t.textSecondary} size={12} lineHeight={16} weight={500}>{q.header}</Label><Label color={k.t.textTertiary} size={12} lineHeight={16}>·</Label></>}
            <Label color={k.t.textTertiary} size={12} lineHeight={16} weight={500} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{`${step + 1} of ${specs.length}`}</Label>
          </div>
        )}
      />
      {!reviewing && body && <QuestionBody text={body} />}
      {reviewing ? (
        <Well>
          {specs.map((s, index) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingTop: 4, paddingBottom: 4 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
                <text style={{ color: k.t.textSecondary, fontSize: 12, lineHeight: 17, minWidth: 0 }}>{splitQuestion(s.title, s.header).title}</text>
                <text style={{ color: k.t.text, fontSize: 13, lineHeight: 18, minWidth: 0, userSelect: 'text' }}>{s.secret ? 'Hidden answer' : answersFor(s).join('\n')}</text>
                {attachmentsFor(s).length > 0 && <text style={{ color: k.t.textSecondary, fontSize: 12, lineHeight: 17, minWidth: 0 }}>{`With ${attachmentsFor(s).map((item) => item.name).join(', ')}`}</text>}
              </div>
              <IconButton icon={T.pencil} label={`Edit answer to ${splitQuestion(s.title, s.header).title}`} size="sm" onClick={() => goto(index)} />
            </div>
          ))}
        </Well>
      ) : wide ? (
        <div testId="question-split" style={{ display: 'flex', gap: 12, marginTop: 10, minWidth: 0 }}>
          {list}
          {preview('pane')}
        </div>
      ) : list}
      {held.length > 0 && (
        <div testId="question-attachments" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, marginLeft: 34, minWidth: 0 }}>
          {held.map((item) => (
            <TokenChip key={item.key} testId="question-attachment" lead={<Icon source={item.kind === 'file' ? G.file : item.kind === 'window' ? ICONS.window : G.image} size={12} color={k.t.textSecondary} />}
              removeLabel={`Remove ${item.name}`} disabled={busy} onRemove={() => detach(q!, item.key)}>{item.name}</TokenChip>
          ))}
        </div>
      )}
      <Hints
        actions
        error={error || attachError}
        left={hint}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: W.gap, flexShrink: 0 }}>
            {canAttach && <AttachMenu disabled={busy} full={held.length >= MAX_ATTACHMENTS} onAdd={attach(q!)} onError={setAttachError} onTouch={pause.touch} />}
            {onDecline && <Button variant="ghost" size="sm" disabled={busy} onClick={onDecline} onKeyboard={keyboardAnswer} testId="question-decline">Decline</Button>}
            {step > 0 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => goto(step - 1)} onKeyboard={keyboardAnswer} icon={T.chevronLeft} testId="question-back">Back</Button>}
            <Button variant="primary" size="sm" swap disabled={busy || !canContinue} onClick={next} onKeyboard={keyboardAnswer} kbd="↵" testId="question-next">{primary}</Button>
          </div>
        }
      />
    </CardShell>
  )
}

/** A blocking request from the harness: questions, a form, or a confirmation. */
export function UserInputPanel({ approval, count }: { approval: ApprovalRequest; count: number }) {
  const k = useCardTokens()
  const input = record(approval.input)
  const questions = questionsFor(approval)
  const [value, setValue] = useState(string(input.prefill ?? input.value))
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const deadline = questionDeadline(approval)
  useEffect(() => { if (deadline) void refreshProgress(approval.thread_id) }, [approval.id])
  const elicitation = approval.tool_name === 'mcp_elicitation'
  const isUrl = elicitation && input.mode === 'url'
  const schema = record(input.requestedSchema ?? input.requested_schema)
  const fieldEntries = Object.entries(record(schema.properties))

  const submit = async (response?: unknown) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await respondApproval(approval.id, response === undefined ? { decision: 'deny' } : { decision: 'submit', response })
    } catch (e) {
      setError(sendFailed(e))
    } finally {
      setBusy(false)
    }
  }

  if (questions.length) {
    return (
      <QuestionCard
        count={count} busy={busy} error={error} deadline={deadline ? { approvalId: approval.id, deadline } : undefined}
        specs={questions.map((q): Spec => ({ id: q.id, title: q.title, header: q.header, options: q.options, multiple: q.multiple, custom: q.custom || !q.options.length, secret: q.secret, attachments: q.attachments }))}
        onDecline={() => void submit()}
        onSend={(answers, attachments) => {
          // A daemon that sends normalized questions builds the harness's response itself, attachments included.
          try { void submit(approval.questions?.length ? normalizedResponse(questions, answers, attachments) : questionResponse(approval, answers)) } catch (e) { setError(sendFailed(e)) }
        }}
      />
    )
  }

  // ui_select / ui_confirm / ui_input / ui_editor / mcp_elicitation forms.
  const options = array(input.options).map(String)
  const confirm = approval.tool_name === 'ui_confirm'
  const send = () => {
    if (!elicitation) return void submit({ value })
    const content: Record<string, unknown> = {}
    for (const [key, raw] of fieldEntries) {
      const spec = record(raw)
      const v = fields[key] ?? (spec.default == null ? '' : String(spec.default))
      if (!v && !array(schema.required).includes(key)) continue
      content[key] = spec.type === 'boolean' ? v === 'true' : spec.type === 'number' || spec.type === 'integer' ? Number(v) : v
    }
    void submit({ action: 'accept', ...(isUrl ? {} : { content }) })
  }
  return (
    <CardShell testId="question-panel" onKey={(e) => {
      if (busy || isPrimary(e.modifiers)) return false
      const n = /^[1-9]$/.test(e.key ?? '') ? Number(e.key) : 0
      if (confirm && n >= 1 && n <= 3) { keyboardAnswer(); void submit(n === 1 ? { confirmed: true } : n === 2 ? { confirmed: false } : undefined); return true }
      if (e.key === 'enter' && approval.tool_name !== 'ui_input' && approval.tool_name !== 'ui_editor' && !confirm && (approval.tool_name !== 'ui_select' || value)) { keyboardAnswer(); send(); return true }
      return false
    }}>
      <RequestHeader glyph={T.question} title={approval.summary || 'Input needed'} aside={count > 1 ? `${count} requests` : undefined} />
      {confirm && (
        <OptionList label={approval.summary}>
          <OptionRow n={1} label={plain('Confirm')} highlighted enterHint disabled={busy} testId="confirm-yes" onClick={() => void submit({ confirmed: true })} />
          <OptionRow n={2} label={plain('Do not confirm')} highlighted={false} disabled={busy} testId="confirm-no" onClick={() => void submit({ confirmed: false })} />
          <OptionRow n={3} label={plain('Decline')} highlighted={false} disabled={busy} testId="confirm-decline" onClick={() => void submit()} />
        </OptionList>
      )}
      {approval.tool_name === 'ui_select' && (
        <OptionList label={approval.summary}>
          {options.map((option, i) => <OptionRow key={option} n={i + 1} label={plain(option)} highlighted={value === option} enterHint={false} disabled={busy} onClick={() => setValue(option)} />)}
        </OptionList>
      )}
      {(approval.tool_name === 'ui_input' || approval.tool_name === 'ui_editor') && (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
          {approval.tool_name === 'ui_editor'
            ? <TextArea label="Answer" testId="form-answer" value={value} onChange={setValue} minRows={6} maxRows={10} />
            : <TextField label="Answer" testId="form-answer" value={value} onChange={setValue} onSubmit={send} />}
        </div>
      )}
      {elicitation && !isUrl && fieldEntries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          {fieldEntries.map(([key, raw]) => {
            const spec = record(raw)
            const required = array(schema.required).includes(key)
            const label = `${string(spec.title) || key}${required ? ' *' : ' (optional)'}`
            return (
              <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Label color={k.t.textSecondary} size={12} lineHeight={16}>{label}</Label>
                <TextField label={label} value={fields[key] ?? (spec.default == null ? '' : String(spec.default))} onChange={(v) => setFields({ ...fields, [key]: v })} />
              </div>
            )
          })}
        </div>
      )}
      {isUrl && (
        <Well>
          <text style={{ color: k.t.text, fontSize: 12, lineHeight: 17, minWidth: 0, userSelect: 'text' }}>{string(input.url)}</text>
          <text style={{ color: k.t.textSecondary, fontSize: 12, lineHeight: 17, minWidth: 0, marginTop: 4 }}>Complete the request in your browser, then continue.</text>
        </Well>
      )}
      <Hints
        error={error}
        left={confirm ? <><Kbd keys={['1']} /><HintText>–</HintText><Kbd keys={['3']} /><HintText>to choose</HintText></> : <HintText>The agent is waiting for your answer.</HintText>}
        right={confirm ? undefined : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" onKeyboard={keyboardAnswer} disabled={busy} onClick={() => void submit()}>Decline</Button>
            <Button variant="primary" size="sm" swap onKeyboard={keyboardAnswer} disabled={busy || (approval.tool_name === 'ui_select' && !value)} onClick={send} testId="form-submit">{busy ? 'Sending…' : isUrl ? 'I’ve finished' : 'Submit'}</Button>
          </div>
        )}
      />
    </CardShell>
  )
}

/** Async questions stay open while the agent works; picking never submits. */
export function AsyncQuestionPanel({ threadId, request, count }: { threadId: ThreadId; request: AsyncQuestionRequest; count: number }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <QuestionCard
      count={count} busy={busy} error={error}
      specs={request.questions.map((q, i): Spec => ({ id: String(i), title: q.title, options: q.options.map((label) => ({ label, description: '' })), multiple: false, custom: true, secret: false }))}
      onSend={async (answers) => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          await answerQuestions(threadId, request.id, answers.map((a) => a.join(', ').trim()))
        } catch (e) {
          setError(sendFailed(e))
        } finally {
          setBusy(false)
        }
      }}
    />
  )
}
