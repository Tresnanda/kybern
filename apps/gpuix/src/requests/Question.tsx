// Questions and input forms in the request family: blocking questions from a harness (`UserInputPanel`), the form-shaped
// requests (`ui_select`, `ui_confirm`, `ui_input`, `ui_editor`, MCP elicitation) and non-blocking async questions.
// A question's options are the same numbered rows as an approval's; its last row is the free answer. The question reads as
// Markdown; the focused option shows its preview (text or code) under the rows; Attach adds an image, a window capture or a
// file to the answer (the "Point for me" kinds, `attach.ts`), which the daemon passes to the agent as paths.
import { useEffect, useRef, useState } from 'react'
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
import { TextArea } from '../kit/TextArea.tsx'
import { TextField } from '../kit/Field.tsx'
import { Label } from '../ui.tsx'
import { TokenChip } from '../kit/TokenChip.tsx'
import { Icon, ICONS } from '../icons.tsx'
import { G } from '../composer/glyphs.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { captureWindow, uploadImage, uploadImageFile } from './attach.ts'
import { openScreenRecordingSettings, screenRecordingGranted } from '../pick/screenRecording.ts'
import { CardShell, DigitKey, HintText, Hints, Kbd, OptionList, OptionRow, RequestHeader, useCardTokens, Well } from './Card.tsx'
import { keyboardAnswer } from './Panel.tsx'
import { DeadlineHint, usePauseController } from './Deadline.tsx'
import { actOnRequest, refreshProgress, useRequestProgress } from './progress.ts'

/** "Wait for me": the question keeps waiting with no deadline (`requests.act hold`). Gone once held. */
function WaitForMe({ approvalId, disabled }: { approvalId: string; disabled: boolean }) {
  const phase = useRequestProgress(approvalId)?.phase
  const [busy, setBusy] = useState(false)
  if (phase === 'held') return null
  return <Button variant="ghost" size="sm" testId="question-hold" disabled={disabled || busy} onKeyboard={keyboardAnswer} onClick={() => { setBusy(true); void actOnRequest(approvalId, 'hold').catch(() => {}).finally(() => setBusy(false)) }}>Wait for me</Button>
}

interface Spec {
  id: string
  /** The question. Markdown. */
  title: string
  /** A short label ("Layout"), the card title when the question itself is long or formatted. */
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

/** A one-line question with no Markdown reads as the card title; anything else is a Markdown body under a short title. */
const MARKDOWN = /[`*_#>|[\]]|\n|^\s*[-+\d]/
export const titleOnly = (question: string) => question.length <= 120 && !MARKDOWN.test(question)

/** Most attachments on one answer (the daemon's `MAX_ANSWER_ATTACHMENTS`). */
const MAX_ATTACHMENTS = 6

/** The question as Markdown, bounded: a long body scrolls inside the card. */
function QuestionBody({ text }: { text: string }) {
  const k = useCardTokens()
  return (
    <div testId="question-body" style={{ display: 'flex', flexDirection: 'column', marginLeft: 34, marginTop: 6, maxHeight: 220, overflowY: 'scroll', minWidth: 0 }}>
      <markdown source={text} theme={cachedMarkdownTheme(k.t)} style={{ color: k.t.text, userSelect: 'text' }} />
    </div>
  )
}

/** The focused option's preview (text or a code block), under the rows. Quiet when that option has none. */
function OptionPreview({ option }: { option: QuestionOption | undefined }) {
  const k = useCardTokens()
  return (
    <Well style={{ gap: 6 }}>
      <Label color={k.t.textTertiary} size={11.5} lineHeight={16} weight={500} truncate>{option ? `Preview · ${option.label}` : 'Preview'}</Label>
      {option?.preview
        ? <div testId="question-preview" style={{ display: 'flex', flexDirection: 'column', maxHeight: 220, overflowY: 'scroll', minWidth: 0 }}>
            <markdown source={option.preview} theme={cachedMarkdownTheme(k.t)} style={{ color: k.t.text, userSelect: 'text' }} />
          </div>
        : <Label color={k.t.textSecondary} size={12.5} lineHeight={18}>This option has no preview.</Label>}
    </Well>
  )
}

/** Attach: an image file, a window capture or a file, the "Point for me" kinds. Uploads happen here; the card holds the result. */
function AttachMenu({ disabled, onAdd, onError, onTouch }: { disabled: boolean; onAdd: (item: UserInputAttachment) => void; onError: (message: string) => void; onTouch: () => void }) {
  const renderer = useGpuixRequired()
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
  return (
    <Menu testId="question-attach-menu" side="top" align="end" minWidth={200} fit="switch"
      trigger={() => <Button variant="ghost" size="sm" icon={G.paperclip} busy={busy} disabled={disabled || busy} onKeyboard={keyboardAnswer} testId="question-attach">Attach</Button>}>
      <MenuItem id="image" icon={G.image} label="Image…" testId="question-attach-image" onSelect={image} />
      <MenuItem id="window" icon={ICONS.window} label="Window capture…" testId="question-attach-window" onSelect={window} />
      <MenuItem id="file" icon={G.file} label="File…" testId="question-attach-file" onSelect={file} />
    </Menu>
  )
}

/** A failed answer: what went wrong, then what to do. */
const sendFailed = (e: unknown) => `Unable to send your answer: ${errorText(e).replace(/\.$/, '')}. Check it and try again.`

/** One step per question, then a review. Answers are picked with digits or a click; ↑ ↓ move, Return continues. */
function QuestionCard({ specs, count, busy, error, onSend, onDecline, deadline }: { specs: Spec[]; count: number; busy: boolean; error: string; onSend: (answers: string[][], attachments: UserInputAttachment[][]) => void; onDecline?: () => void; /** A daemon question that answers itself with its defaults. */ deadline?: { approvalId: string; deadline: QuestionDeadline } }) {
  const k = useCardTokens()
  const [attached, setAttached] = useState<Record<string, Held[]>>({})
  const [attachError, setAttachError] = useState('')
  const [step, setStep] = useState(0)
  // The default rows start picked (and highlighted), so Send answer sends what the countdown would.
  const defaults = (q: Spec) => defaultOption(deadline?.deadline ?? null, q)
  const [selected, setSelected] = useState<Record<string, string[]>>(() => Object.fromEntries(specs.flatMap((q) => defaults(q) >= 0 && !q.multiple ? [[q.id, [q.options[defaults(q)]!.label]]] : [])))
  const deadlinePhase = useRequestProgress(deadline?.approvalId ?? '')?.phase
  const pause = usePauseController(deadline?.approvalId ?? '', !!deadline && deadlinePhase !== 'held')
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [cursor, setCursor] = useState(() => Math.max(0, specs[0] ? defaults(specs[0]) : 0))
  const reviewing = step === specs.length
  // One question with a deadline sends straight away: its default is already picked, as the countdown would send it.
  const direct = !!deadline && specs.length === 1
  const answersFor = (q: Spec): string[] => custom[q.id]?.trim() ? [...(q.multiple ? (selected[q.id] ?? []) : []), custom[q.id]!.trim()] : (selected[q.id] ?? [])
  const attachmentsFor = (q: Spec): Held[] => attached[q.id] ?? []
  // A question that takes a written answer may be answered with attachments alone ("which looks right?" → a screenshot).
  const answered = (q: Spec) => answersFor(q).length > 0 || (q.custom && attachmentsFor(q).length > 0)
  const ready = specs.every(answered)
  const canContinue = reviewing ? ready : !!specs[step] && answered(specs[step]!)
  const send = () => onSend(specs.map(answersFor), specs.map((q) => attachmentsFor(q).map(({ key: _key, ...item }) => item)))
  const q = specs[step]
  const rows = q?.options.length ?? 0
  const total = rows + (q?.custom && !q.secret ? 1 : 0)
  const goto = (next: number) => { setStep(next); setCursor(0) }
  const next = () => {
    if (busy || !canContinue) return
    if (reviewing || direct) send()
    else goto(step + 1)
  }
  const pick = (index: number) => {
    if (!q || busy) return
    const option = q.options[index]
    if (!option) return
    setCursor(index)
    const current = selected[q.id] ?? []
    setSelected({ ...selected, [q.id]: q.multiple ? (current.includes(option.label) ? current.filter((v) => v !== option.label) : [...current, option.label]) : [option.label] })
    if (!q.multiple) setCustom({ ...custom, [q.id]: '' })
  }
  const onKey = (e: { key?: string; modifiers?: { cmd?: boolean } }): boolean => {
    if (busy || reviewing || e.modifiers?.cmd) return false
    if (e.key && /^([1-9]|up|down|space|enter)$/.test(e.key)) pause.touch()
    const key = e.key ?? ''
    if (/^[1-9]$/.test(key)) { const i = Number(key) - 1; if (i < rows) { keyboardAnswer(); pick(i); return true } return false }
    if (key === 'up' || key === 'down') {
      const to = (cursor + (key === 'down' ? 1 : -1) + Math.max(rows, 1)) % Math.max(rows, 1)
      setCursor(to)
      if (q && !q.multiple && q.options[to]) pick(to)
      return true
    }
    if (key === 'space' && q?.multiple) { pick(cursor); return true }
    if (key === 'enter') { keyboardAnswer(); if (canContinue) next(); else pick(cursor); return true }
    return false
  }
  const last = step === specs.length - 1
  const attach = (q: Spec) => (item: UserInputAttachment) => {
    pause.touch()
    setAttached((current) => ({ ...current, [q.id]: [...(current[q.id] ?? []), { ...item, key: crypto.randomUUID() }].slice(0, MAX_ATTACHMENTS) }))
  }
  const detach = (q: Spec, key: string) => setAttached((current) => ({ ...current, [q.id]: (current[q.id] ?? []).filter((item) => item.key !== key) }))
  const plainTitle = !reviewing && titleOnly(q!.title)
  const previews = !reviewing && q!.options.some((option) => option.preview)
  const canAttach = !reviewing && !!q?.attachments && !q.secret
  const held = q ? attachmentsFor(q) : []
  return (
    <CardShell testId="question-panel" onKey={onKey} {...(deadline ? { onPointerEnter: () => pause.hover(true), onPointerLeave: () => pause.hover(false), onFocusIn: pause.touch } : {})}>
      <RequestHeader
        glyph={T.question}
        title={reviewing ? 'Review your answers' : plainTitle ? q!.title : q!.header || 'Question'}
        aside={reviewing ? `${specs.length} answered` : `Question ${step + 1} of ${specs.length}${count > 1 ? ` · ${count} requests` : ''}`}
        meta={!reviewing && q!.multiple && plainTitle ? 'Select all that apply.' : undefined}
      />
      {!reviewing && !plainTitle && <QuestionBody text={q!.multiple ? `${q!.title}\n\n*Select all that apply.*` : q!.title} />}
      {reviewing ? (
        <Well>
          {specs.map((s, index) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingTop: 4, paddingBottom: 4 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
                <text style={{ color: k.t.textSecondary, fontSize: 12, lineHeight: 17, minWidth: 0 }}>{s.title}</text>
                <text style={{ color: k.t.text, fontSize: 13, lineHeight: 18, minWidth: 0, userSelect: 'text' }}>{s.secret ? 'Hidden answer' : answersFor(s).join('\n')}</text>
                {attachmentsFor(s).length > 0 && <text style={{ color: k.t.textSecondary, fontSize: 12, lineHeight: 17, minWidth: 0 }}>{`With ${attachmentsFor(s).map((item) => item.name).join(', ')}`}</text>}
              </div>
              <IconButton icon={T.pencil} label={`Edit answer to ${s.title}`} size="sm" onClick={() => goto(index)} />
            </div>
          ))}
        </Well>
      ) : (
        <OptionList label={q!.title}>
          {q!.options.map((option, i) => {
            const checked = (selected[q!.id] ?? []).includes(option.label) && !(!q!.multiple && custom[q!.id]?.trim())
            return (
              <OptionRow
                key={option.label} n={q!.multiple ? undefined : i + 1} label={plain(option.label)} description={option.description} testId={`question-option-${i}`}
                tag={deadline && defaults(q!) === i ? 'Default' : undefined}
                role={q!.multiple ? 'checkbox' : 'radio'} highlighted={checked} cursor={q!.multiple && cursor === i && !checked} enterHint={false} disabled={busy} dim={busy}
                lead={q!.multiple ? <div style={{ display: 'flex', paddingTop: 1 }}><Checkbox checked={checked} aria-label={option.label} style={{ pointerEvents: 'none' }} /></div> : undefined}
                onClick={() => pick(i)}
              />
            )
          })}
          {q!.custom && !q!.secret && (
            <OptionRow
              n={q!.multiple ? undefined : rows + 1} label={plain(q!.options.length ? (q!.multiple ? 'Add an answer' : 'Write your own answer') : 'Your answer')} testId="question-row-custom"
              highlighted={!!custom[q!.id]?.trim()} enterHint={false} disabled={busy} dim={busy} onClick={() => {}}
              lead={q!.multiple ? <div style={{ display: 'flex', paddingTop: 1 }}><DigitKey n="+" highlighted={!!custom[q!.id]?.trim()} /></div> : undefined}
            >
              <div style={{ display: 'flex', marginTop: 7 }}>
                <TextField
                  label="Your answer" testId="question-answer" value={custom[q!.id] ?? ''} placeholder="Type an answer" shell={{ flexGrow: 1, height: 30, borderRadius: 8 }}
                  onChange={(v) => { pause.touch(); setCustom({ ...custom, [q!.id]: v }); if (!q!.multiple && v) setSelected({ ...selected, [q!.id]: [] }) }}
                  interceptKeys={['enter']} onKeyDown={(e) => { if (e.key === 'enter' && canContinue) { e.preventDefault(); next() } }}
                />
              </div>
            </OptionRow>
          )}
        </OptionList>
      )}
      {previews && <OptionPreview option={q!.options[cursor]} />}
      {held.length > 0 && (
        <div testId="question-attachments" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, minWidth: 0 }}>
          {held.map((item) => (
            <TokenChip key={item.key} testId="question-attachment" lead={<Icon source={item.kind === 'file' ? G.file : G.image} size={12} color={k.t.textSecondary} />}
              removeLabel={`Remove ${item.name}`} disabled={busy} onRemove={() => detach(q!, item.key)}>{item.name}</TokenChip>
          ))}
        </div>
      )}
      <Hints
        error={error || attachError}
        left={deadline && !reviewing ? <DeadlineHint approvalId={deadline.approvalId} deadline={deadline.deadline} chosen={specs.length === 1 && defaults(specs[0]!) >= 0 ? specs[0]!.options[defaults(specs[0]!)]!.label : null} /> : reviewing ? <HintText>Check your answers before sending.</HintText> : total > 1 && rows > 0
          ? <><Kbd keys={['↑', '↓']} /><HintText>to move</HintText><HintText>·</HintText><Kbd keys={['1']} /><HintText>–</HintText><Kbd keys={[String(rows)]} /><HintText>{q!.multiple ? 'to toggle' : 'to choose'}</HintText></>
          : <HintText>The agent is waiting for your answer.</HintText>}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {canAttach && <AttachMenu disabled={busy || held.length >= MAX_ATTACHMENTS} onAdd={attach(q!)} onError={setAttachError} onTouch={pause.touch} />}
            {deadline && <WaitForMe approvalId={deadline.approvalId} disabled={busy} />}
            {onDecline && <Button variant="ghost" size="sm" disabled={busy} onClick={onDecline} onKeyboard={keyboardAnswer} testId="question-decline">Decline</Button>}
            {step > 0 && <Button size="sm" disabled={busy} onClick={() => goto(step - 1)} onKeyboard={keyboardAnswer} icon={T.arrowLeft}>Previous</Button>}
            <Button variant="primary" size="sm" swap disabled={busy || !canContinue} onClick={next} onKeyboard={keyboardAnswer} kbd="↵" testId="question-next">
              {busy ? 'Sending…' : reviewing || direct ? (specs.length === 1 ? 'Send answer' : 'Send answers') : last ? 'Review answers' : 'Next'}
            </Button>
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
      if (busy || e.modifiers?.cmd) return false
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
