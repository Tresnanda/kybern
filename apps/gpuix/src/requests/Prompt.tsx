// The password prompt (`kybern_askpass`): a command the agent ran asks for a password through Kybern's askpass helper (sudo, an SSH
// passphrase, git credentials, or a yes/no on an unknown SSH host key). Always a closed form: the composer input hides, Esc is
// ignored, it is never answered automatically, and it rises in even right after a keyboard answer (`PanelEnter always`). The value
// lives in a ref, is cleared after sending and on unmount, and never reaches React state. Spec: `cards/spec.md` §2.
import { useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, PromptRequestInput, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { lockLine, passwordCopy, passwordMeta, passwordPurpose, wrongAnswerError } from '../../../../packages/kybern-client/src/requestCards.ts'
import { useApp } from '../state.ts'
import { Button } from '../kit/Button.tsx'
import { FieldShell } from '../kit/Field.tsx'
import { FONT_MONO, FONT_UI } from '../theme.ts'
import { respondApproval } from '../transcript/store.ts'
import { Label, ProviderMark } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { CardShell, CodeWell, HintText, Hints, Kbd, KeyValueWell, RequestHeader, useCardTokens } from './Card.tsx'
import { actionFailed, agentFor, ChoiceRows, useChoices, type Choice } from './choices.tsx'
import { threadProvider } from './actions.ts'
import { agentName } from './model.ts'
import { RG } from './glyphs.ts'
import { keyboardAnswer } from './Panel.tsx'
import { someoneIsTyping } from './ui.ts'

/** The provider kind behind the harness's display name in the input ("Claude Code" → `claude-code`), for its mark. */
export function harnessKind(harness: string): string | undefined {
  const name = harness.toLowerCase()
  return name.startsWith('claude') ? 'claude-code' : name.startsWith('codex') ? 'codex' : name.startsWith('opencode') ? 'opencode' : name.startsWith('cursor') ? 'cursor' : name === 'pi' || name.startsWith('pi ') ? 'pi' : name.startsWith('omp') ? 'omp' : undefined
}

/** "Claude" for "Claude Code": the agent's short name for the lock line. */
const harnessAgent = (harness: string): string | undefined => { const kind = harnessKind(harness); return kind ? agentName(kind) : undefined }

export function PromptRequestPanel({ approval, input, count, threadId }: { approval: ApprovalRequest; input: PromptRequestInput; count: number; threadId: ThreadId }) {
  const k = useCardTokens()
  const copy = passwordCopy(input)
  const hostKey = passwordPurpose(input) === 'ssh_host_key'
  const title = useApp((s) => s.threads.find((t) => t.id === approval.thread_id)?.title ?? (s.open.thread?.id === approval.thread_id ? s.open.thread.title : null))
  const provider = harnessKind(input.harness) ?? threadProvider(approval.thread_id)
  const [expanded, setExpanded] = useState(false)
  const header = (
    <RequestHeader
      glyph={RG[copy.glyph]} title={copy.title} badge={count > 1 ? `1 of ${count}` : undefined}
      chip={{ label: input.harness }} chipMark={provider ? <ProviderMark kind={provider} size={12} /> : undefined}
      meta={passwordMeta(input, title ?? null)}
    />
  )
  const command = input.command ? <CodeWell command={input.command} expanded={expanded} onToggle={() => setExpanded((v) => !v)} /> : null
  if (hostKey) return <HostKeyCard approval={approval} input={input} threadId={threadId} header={header} command={command} />
  return (
    <CardShell testId="prompt-panel" stealFocus={false}>
      {header}
      {command}
      {input.prompt && (
        <div testId="prompt-caption" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 8, paddingLeft: 2, minWidth: 0 }}>
          <Label color={k.t.textSecondary} size={12} lineHeight={17}>The prompt says</Label>
          <text style={{ color: k.t.textSecondary, fontFamily: FONT_MONO, fontSize: 11.5, lineHeight: 17, minWidth: 0, userSelect: 'text' }}>{input.prompt.trim()}</text>
        </div>
      )}
      <PromptField approval={approval} input={input} />
    </CardShell>
  )
}

function PromptField({ approval, input }: { approval: ApprovalRequest; input: PromptRequestInput }) {
  const k = useCardTokens()
  const copy = passwordCopy(input)
  const value = useRef('')
  useEffect(() => () => { value.current = '' }, [])
  const [autoFocus] = useState(() => !someoneIsTyping())
  const canReveal = input.secret && (input.purpose === 'ssh_passphrase' || input.purpose === 'git_password')
  const [revealed, setRevealed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hasValue, setHasValue] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const wrong = wrongAnswerError(input)
  const respond = async (send: boolean) => {
    if (busy || (send && !value.current)) return
    setBusy(true); setError('')
    try {
      await respondApproval(approval.id, send ? { decision: 'submit', response: input.secret ? { secret: value.current } : { value: value.current } } : { decision: 'deny' })
      value.current = ''; setHasValue(false)
    } catch (e) { setError(`${actionFailed(e).replace(/\.$/, '')}. Check the connection and try again.`); setBusy(false) }
  }
  return (
    <>
      {copy.label && <Label color={k.t.textSecondary} size={12} lineHeight={16} weight={500} style={{ marginTop: 12, paddingLeft: 2 }}>{copy.label}</Label>}
      <FieldShell size="lg" focused={focused} style={{ marginTop: copy.label ? 6 : 12, paddingRight: canReveal ? 4 : undefined }} trailing={canReveal
        ? <Button variant="ghost" size="sm" testId="prompt-reveal" label={revealed ? `Hide ${copy.noun}` : `Show ${copy.noun}`} onClick={() => setRevealed((v) => !v)}>{revealed ? 'Hide' : 'Show'}</Button>
        : undefined}>
        <div style={{ position: 'relative', display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0, height: '100%' }}>
          {!hasValue && (
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', pointerEvents: 'none' }}>
              <Label color={k.t.textPlaceholder} size={14} truncate>{copy.placeholder}</Label>
            </div>
          )}
          <input
            {...{ secure: input.secret && !revealed, spellcheck: false, autocomplete: 'off' }} autoFocus={autoFocus}
            testId="prompt-input" aria-label={copy.label ?? copy.placeholder} readOnly={busy}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            onChange={(e) => { value.current = e.value ?? ''; setHasValue(!!value.current); setError('') }}
            onSubmit={() => void respond(true)}
            style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, height: '100%', borderWidth: 0, fontFamily: FONT_UI, fontSize: 14, color: k.t.text, backgroundColor: 'rgba(0, 0, 0, 0)' }}
          />
        </div>
      </FieldShell>
      {wrong && !hasValue && <text testId="prompt-wrong" style={{ color: k.del, fontSize: 12, lineHeight: 17, fontFamily: '.SystemUIFont', marginTop: 8, paddingLeft: 2, minWidth: 0 }}>{wrong}</text>}
      {input.secret && (
        <div testId="prompt-lock-line" style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 8, paddingLeft: 2, minWidth: 0 }}>
          <div style={{ display: 'flex', height: 17, alignItems: 'center', flexShrink: 0 }}><Icon source={RG.lock} size={12} color={k.t.textTertiary} /></div>
          <text style={{ color: k.t.textTertiary, fontSize: 11.5, lineHeight: 17, fontFamily: '.SystemUIFont', minWidth: 0 }}>{lockLine(harnessAgent(input.harness) ?? agentFor(approval))}</text>
        </div>
      )}
      <Hints
        error={error}
        left={<HintText>{copy.hint}</HintText>}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" testId="prompt-cancel" disabled={busy} onKeyboard={keyboardAnswer} onClick={() => void respond(false)}>Cancel</Button>
            <Button variant="primary" size="sm" swap kbd="↵" testId="prompt-send" disabled={busy || !hasValue} onKeyboard={keyboardAnswer} onClick={() => void respond(true)}>{busy ? 'Sending…' : 'Send'}</Button>
          </div>
        }
      />
    </>
  )
}

/** "Trust this server?": the fingerprint in a well and two rows, none highlighted. Trusting a host takes a digit or a click. */
function HostKeyCard({ approval, input, threadId, header, command }: { approval: ApprovalRequest; input: PromptRequestInput; threadId: ThreadId; header: React.ReactNode; command: React.ReactNode }) {
  const answer = (confirmed: boolean) => respondApproval(approval.id, { decision: 'submit', response: { confirmed } })
  const choices: Choice[] = [
    { label: 'Trust and connect', testId: 'hostkey-trust', run: () => answer(true) },
    { label: 'Don’t connect', testId: 'hostkey-refuse', run: () => answer(false) },
  ]
  const state = useChoices(approval, threadId, choices, { initial: null, enterInert: true, onEscape: () => true })
  return (
    <CardShell testId="prompt-panel" onKey={(e) => (/^[1-9]$/.test(e.key ?? '') || e.key === 'enter' ? state.onKey(e.key!) : false)}>
      {header}
      {command}
      <KeyValueWell testId="hostkey-well" rows={[
        ...(input.host ? [{ key: 'Host', value: input.host, mono: true }] : []),
        ...(input.key_type ? [{ key: 'Key', value: input.key_type, mono: true }] : []),
        ...(input.fingerprint ? [{ key: 'Fingerprint', value: input.fingerprint, mono: true }] : []),
      ]} />
      <ChoiceRows approval={approval} title="Trust this server?" choices={choices} state={state} />
      <Hints
        error={state.ui.error}
        left={state.ui.sending !== null ? <HintText>Sending your choice…</HintText> : <><Kbd keys={['1']} /><HintText>or</HintText><Kbd keys={['2']} /><HintText>to choose</HintText><HintText>·</HintText><Kbd keys={['↵']} /><HintText>is off for this choice</HintText></>}
      />
    </CardShell>
  )
}
