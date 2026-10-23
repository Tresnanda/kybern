// The sign-in card (`kybern_request_login`): the agent asks you to sign a CLI in. Kybern runs the login in the daemon and follows it
// through `RequestProgress`: a choice card while it asks, a status line with the device code while it waits, a closed form for CLIs
// that want a pasted code, and a green "Signed in" frame before the daemon resolves it. Only the decline row answers the approval;
// every other button is `requests.act`. Spec: `.kybern-artifacts/ade-69-71/cards/spec.md` §1.
import { useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, LoginRequestInput, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { loginDoneTitle, loginTitle, loginWaitingLine, shortUrl } from '../../../../packages/kybern-client/src/requestCards.ts'
import { Icon } from '../icons.tsx'
import { Button } from '../kit/Button.tsx'
import { TextField } from '../kit/Field.tsx'
import { openExternal } from '../settings/external.ts'
import { openTerminalTab } from '../tabs/open.ts'
import { FONT_MONO } from '../theme.ts'
import { T } from '../transcript/glyphs.ts'
import { copyText, readClipboardText } from '../transcript/store.ts'
import { Label } from '../ui.tsx'
import { cancelTurn } from './actions.ts'
import { CancelLink, CardShell, HintText, Hints, Kbd, KeyValueWell, RequestHeader, StatusRow, useCardTokens, Well } from './Card.tsx'
import { actionFailed, ChoiceRows, declineLabel, agentFor, useChoices, type Choice } from './choices.tsx'
import { serviceMark } from './glyphs.ts'
import { keyboardAnswer } from './Panel.tsx'
import { actOnRequest, refreshProgress, useRequestProgress } from './progress.ts'
import { CodeText, PhaseIn, TimeLeft } from './summoned.tsx'
import { someoneIsTyping } from './ui.ts'

/** Which body the card shows for the daemon's phase. */
export function loginView(phase: string | undefined): 'ask' | 'wait' | 'paste' | 'done' {
  if (phase === 'waiting' || phase === 'verifying') return 'wait'
  if (phase === 'paste_code') return 'paste'
  if (phase === 'done') return 'done'
  return 'ask'
}

export function LoginRequestPanel({ approval, input, count, threadId }: { approval: ApprovalRequest; input: LoginRequestInput; count: number; threadId: ThreadId }) {
  const k = useCardTokens()
  const progress = useRequestProgress(approval.id)
  const view = loginView(progress?.phase)
  const agent = agentFor(approval)
  const [actError, setActError] = useState('')
  // The page opens on this Mac only after this client chose the browser (a reconnect or another client never opens it again).
  const wantsPage = useRef(false)
  useEffect(() => { void refreshProgress(approval.thread_id) }, [approval.id, approval.thread_id])
  useEffect(() => {
    if (!wantsPage.current || !progress?.url || progress.method === 'terminal' || (view !== 'wait' && view !== 'paste')) return
    wantsPage.current = false
    void openExternal(progress.url).catch(() => setActError('Unable to open the sign-in page. Use Open page again.'))
  }, [progress?.url, progress?.method, view])

  const act = async (action: string, value?: string) => {
    setActError('')
    if (action === 'browser') wantsPage.current = true
    try { await actOnRequest(approval.id, action, value) } catch (e) { wantsPage.current = false; throw e }
  }
  const failed = progress?.phase === 'failed'
  const choices: Choice[] = [
    ...input.methods.map((method): Choice => method === 'terminal'
      ? { label: 'Sign in from a terminal', testId: 'login-row-terminal', run: () => act('terminal') }
      : { label: failed ? 'Try again with the browser' : 'Sign in with the browser', testId: 'login-row-browser', run: () => act('browser') }),
    { label: declineLabel(approval), decline: true, testId: 'login-row-decline' },
  ]
  const state = useChoices(approval, threadId, choices, {
    active: view === 'ask',
    // Asking: Esc cancels the turn, as on every choice card. Waiting: it stops the sign-in. The paste form ignores it.
    onEscape: () => {
      if (view === 'ask') cancelTurn(threadId)
      else if (view === 'wait') void act('cancel').catch((e) => setActError(actionFailed(e)))
      return true
    },
  })
  const error = actError || state.ui.error || (failed ? progress?.error || 'The sign-in did not finish. Try again, or sign in from a terminal.' : '')
  const mark = <Icon source={serviceMark(input.cli)} size={14} color={k.t.text} />
  const chip = { label: input.cli, mono: true }
  const badge = count > 1 ? `1 of ${count}` : undefined

  if (view === 'done') {
    return (
      <CardShell testId="login-panel" stealFocus={false}>
        <RequestHeader glyph={T.terminal} tone="success" title={loginDoneTitle(input.service, progress?.account)} chip={chip} badge={badge} />
        <PhaseIn phase="done"><StatusRow tone="done" testId="login-done" label={`${agent} is continuing.`} /></PhaseIn>
      </CardShell>
    )
  }
  if (view === 'paste') return <LoginPasteForm approval={approval} input={input} badge={badge} error={error || progress?.error || ''} act={act} />
  if (view === 'wait') return <LoginWaiting approvalId={approval.id} threadId={threadId} input={input} badge={badge} error={error} act={act} />
  return (
    <CardShell testId="login-panel" onKey={(e) => state.onKey(e.key ?? '')}>
      <RequestHeader glyph={T.terminal} tileMark={mark} title={loginTitle(input)} chip={chip} badge={badge} meta={input.reason || undefined} error={error || undefined} />
      <PhaseIn phase="ask">
        {!failed && (
          <KeyValueWell testId="login-well" rows={[
            ...(input.account ? [{ key: 'Account', value: input.account }] : []),
            ...(input.access ? [{ key: 'Access', value: input.access }] : []),
            ...(input.signs_in ? [{ key: 'Signs in', value: input.signs_in }] : []),
          ]} />
        )}
        <ChoiceRows approval={approval} title={loginTitle(input)} choices={choices} state={state} />
        <Hints
          left={state.ui.sending !== null ? <HintText>Starting the sign-in…</HintText> : state.ui.note
            ? <><Kbd keys={['↵']} /><HintText>to send your note</HintText><HintText>·</HintText><Kbd keys={['esc']} /><HintText>to go back</HintText></>
            : <><Kbd keys={['↑', '↓']} /><HintText>to move</HintText><HintText>·</HintText><Kbd keys={['1']} /><HintText>–</HintText><Kbd keys={[String(choices.length)]} /><HintText>or</HintText><Kbd keys={['↵']} /><HintText>to choose</HintText></>}
          right={state.ui.sending !== null || state.ui.note ? undefined : <CancelLink onClick={() => cancelTurn(threadId, false)} />}
        />
      </PhaseIn>
    </CardShell>
  )
}

/** The device code in Menlo 20, its dash quieter, with Copy code (→ "Copied" for 1.5 s). */
function DeviceCode({ code, url }: { code: string; url?: string | null }) {
  const k = useCardTokens()
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer) }, [copied])
  const copy = () => { copyText(code); setCopied(true) }
  const pieces = code.split(/([-–])/)
  return (
    <Well>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div testId="login-code" style={{ display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          {pieces.map((piece, i) => <Label key={i} color={/^[-–]$/.test(piece) ? k.t.textTertiary : k.t.text} size={20} lineHeight={28} weight={600} font={FONT_MONO} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{piece}</Label>)}
        </div>
        <Button size="sm" testId="login-copy" icon={copied ? T.check : T.copy} swap label={copied ? 'Copied' : 'Copy code'} onClick={copy}>{copied ? 'Copied' : 'Copy code'}</Button>
      </div>
      {url && <div style={{ display: 'flex', marginTop: 4 }}><CodeText text={`Enter this code on the page that just opened, \`${shortUrl(url)}\`.`} /></div>}
    </Well>
  )
}

function LoginWaiting({ approvalId, threadId, input, badge, error, act }: { approvalId: string; threadId: ThreadId; input: LoginRequestInput; badge?: string; error: string; act: (action: string, value?: string) => Promise<void> }) {
  const progress = useRequestProgress(approvalId)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const terminal = progress?.method === 'terminal'
  const cancel = async (keyboard: boolean) => {
    if (busy) return
    if (keyboard) keyboardAnswer()
    setBusy(true); setFailure('')
    try { await act('cancel') } catch (e) { setFailure(actionFailed(e)) } finally { setBusy(false) }
  }
  const openAgain = () => {
    if (terminal && progress?.terminal) openTerminalTab(threadId, { id: progress.terminal.id, title: progress.terminal.title || undefined })
    else if (progress?.url) void openExternal(progress.url).catch(() => setFailure('Unable to open the sign-in page. Copy the code and open it yourself.'))
  }
  return (
    <CardShell testId="login-panel" cmdKeys={['c']} onKey={(e) => {
      if (e.key === 'escape') { void cancel(true); return true }
      if (e.key === 'c' && e.modifiers?.cmd && progress?.user_code) { copyText(progress.user_code); return true }
      return false
    }}>
      <RequestHeader glyph={T.terminal} tileMark={<WaitingMark cli={input.cli} />} title={loginTitle(input)} chip={{ label: input.cli, mono: true }} badge={badge} error={failure || error || undefined} />
      <PhaseIn phase="wait">
        {!terminal && progress?.user_code && <DeviceCode code={progress.user_code} url={progress.url} />}
        <StatusRow testId="login-status" label={progress ? loginWaitingLine(progress) : 'Waiting for you to finish in the browser…'} trailing={progress?.ends_at ? <TimeLeft endsAt={progress.ends_at} /> : undefined} />
        <Hints
          left={<HintText>Kybern checks every 2 s and continues on its own.</HintText>}
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <Button variant="ghost" size="sm" testId="login-cancel" disabled={busy} onKeyboard={keyboardAnswer} onClick={() => void cancel(false)}>Cancel</Button>
              {(terminal ? progress?.terminal : progress?.url) && <Button size="sm" testId="login-reopen" onClick={openAgain}>{terminal ? 'Show terminal' : 'Open page again'}</Button>}
            </div>
          }
        />
      </PhaseIn>
    </CardShell>
  )
}

function WaitingMark({ cli }: { cli: string }) {
  const k = useCardTokens()
  return <Icon source={serviceMark(cli)} size={14} color={k.t.text} />
}

/** Closed form for CLIs that show a code in the browser and wait for it on stdin. Esc is ignored; Cancel stops the sign-in. */
function LoginPasteForm({ approval, input, badge, error, act }: { approval: ApprovalRequest; input: LoginRequestInput; badge?: string; error: string; act: (action: string, value?: string) => Promise<void> }) {
  const k = useCardTokens()
  const [value, setValue] = useState('')
  const [autoFocus] = useState(() => !someoneIsTyping())
  const [busy, setBusy] = useState<'' | 'paste' | 'cancel'>('')
  const [failure, setFailure] = useState('')
  const run = async (action: 'paste' | 'cancel') => {
    if (busy || (action === 'paste' && !value.trim())) return
    setBusy(action); setFailure('')
    try { await act(action, action === 'paste' ? value.trim() : undefined); if (action === 'paste') setValue('') } catch (e) { setFailure(actionFailed(e)) } finally { setBusy('') }
  }
  return (
    <CardShell testId="login-paste-panel" stealFocus={false}>
      <RequestHeader glyph={T.terminal} tileMark={<WaitingMark cli={input.cli} />} title={loginTitle(input)} chip={{ label: input.cli, mono: true }} badge={badge} meta={`${input.service} shows a verification code in the browser. Paste it here.`} error={failure || error || undefined} />
      <PhaseIn phase="paste">
        <TextField
          label="Verification code" testId="login-code-input" size="lg" mono value={value} disabled={!!busy} autoFocus={autoFocus} placeholder="Paste the code"
          {...{ spellcheck: false, autocomplete: 'off' }} style={{ fontSize: 13 }} shell={{ marginTop: 12, paddingRight: 4 }}
          onChange={(next) => { setValue(next); setFailure('') }} onSubmit={() => void run('paste')}
          trailing={<Button variant="ghost" size="sm" testId="login-paste-clipboard" label="Paste the code" onClick={() => { const text = readClipboardText().trim(); if (text) setValue(text) }}>Paste</Button>}
        />
        <Hints
          left={<CodeText text={`The code goes to the \`${input.cli}\` CLI only.`} color={k.t.textTertiary} />}
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <Button variant="ghost" size="sm" testId="login-paste-cancel" disabled={!!busy} onKeyboard={keyboardAnswer} onClick={() => void run('cancel')}>Cancel</Button>
              <Button variant="primary" size="sm" swap kbd="↵" testId="login-paste-continue" disabled={!!busy || !value.trim()} onKeyboard={keyboardAnswer} onClick={() => void run('paste')}>{busy === 'paste' ? 'Checking…' : 'Continue'}</Button>
            </div>
          }
        />
      </PhaseIn>
    </CardShell>
  )
}
