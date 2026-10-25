// The macOS permission card (`kybern_request_permission`): the app being built needs a privacy permission. Row 1 opens the pane in
// System Settings on this Mac and tells the daemon (`requests.act open`), which then watches the grant (progress `waiting`) and
// resolves the card once it is on. Only Decline answers the approval. The tile is the pane's glyph: the daemon sends no app icon.
// Spec: `cards/spec.md` §6.
import { useEffect, useState } from 'react'
import type { ApprovalRequest, PermissionRequestInput, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { permissionGrantedTitle, permissionPane, permissionStillOffMeta, permissionStillOffTitle, permissionTitle, permissionWaitingLine } from '../../../../packages/kybern-client/src/requestCards.ts'
import { Icon, ICONS } from '../icons.tsx'
import { Button } from '../kit/Button.tsx'
import { openSystemSettings, revealInFinder, systemSettingsFailure } from '../settings/external.ts'
import { FONT_MONO } from '../theme.ts'
import { Label } from '../ui.tsx'
import { cancelTurn } from './actions.ts'
import { CancelLink, CardShell, HintText, Hints, Kbd, RequestHeader, StatusRow, useCardTokens, Well } from './Card.tsx'
import { actionFailed, agentFor, ChoiceRows, declineLabel, useChoices, type Choice } from './choices.tsx'
import { paneGlyph } from './glyphs.ts'
import { keyboardAnswer } from './Panel.tsx'
import { actOnRequest, refreshProgress, useRequestProgress } from './progress.ts'
import { PhaseIn } from './summoned.tsx'

export function permissionView(phase: string | undefined): 'ask' | 'wait' | 'off' | 'done' {
  if (phase === 'waiting') return 'wait'
  if (phase === 'not_granted') return 'off'
  if (phase === 'done') return 'done'
  return 'ask'
}

/** The app, its bundle id or path, and the exact pane. */
export function AppWell({ input }: { input: PermissionRequestInput }) {
  const k = useCardTokens()
  const id = input.bundle_id ?? input.app_path
  return (
    <Well style={{ paddingTop: 8, paddingBottom: 8 }}>
      <div testId="permission-well" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 7, flexShrink: 0, backgroundColor: k.chipBg }}>
          <Icon source={ICONS.window} size={16} color={k.t.textSecondary} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          <Label color={k.t.text} size={13} lineHeight={18} weight={600} truncate>{input.app}</Label>
          {id && <Label color={k.t.textTertiary} size={11} lineHeight={15} font={FONT_MONO} truncate>{id}</Label>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 1, minWidth: 0 }}>
          <Icon source={paneGlyph(input.pane)} size={13} color={k.t.textTertiary} />
          <Label color={k.t.textSecondary} size={12} lineHeight={16} truncate>{input.pane_label}</Label>
        </div>
      </div>
    </Well>
  )
}

export function PermissionRequestPanel({ approval, input, count, threadId }: { approval: ApprovalRequest; input: PermissionRequestInput; count: number; threadId: ThreadId }) {
  const k = useCardTokens()
  const progress = useRequestProgress(approval.id)
  const view = permissionView(progress?.phase)
  const agent = agentFor(approval)
  const [actError, setActError] = useState('')
  useEffect(() => { void refreshProgress(approval.thread_id) }, [approval.id, approval.thread_id])

  const act = async (action: string) => { setActError(''); await actOnRequest(approval.id, action) }
  const open = async () => {
    await openSystemSettings(progress?.url || input.url).catch(() => { throw new Error(systemSettingsFailure(input.pane_label, ', then choose Check again')) })
    if (input.needs_app_added && input.app_path) await revealInFinder(input.app_path).catch(() => {})
    await act('open')
  }
  const confirm: Choice = input.detects
    ? { label: 'Check again', testId: 'permission-row-check', run: () => act('check') }
    : { label: 'I’ve granted it', testId: 'permission-row-granted', run: () => act('granted') }
  const choices: Choice[] = [
    { label: input.needs_app_added ? 'Open System Settings and show the app in Finder' : 'Open System Settings', testId: 'permission-row-open', run: open },
    ...(view === 'off' ? [confirm] : []),
    { label: declineLabel(approval), decline: true, testId: 'permission-row-decline' },
  ]
  const stop = async (keyboard: boolean) => {
    if (keyboard) keyboardAnswer()
    try { await act('stop') } catch (e) { setActError(actionFailed(e)) }
  }
  const state = useChoices(approval, threadId, choices, {
    active: view === 'ask' || view === 'off',
    // Asking: Esc cancels the turn. Waiting: it stops waiting (the tool returns `declined`).
    onEscape: () => { if (view === 'wait') void stop(true); else if (view !== 'done') cancelTurn(threadId); return true },
  })
  const chip = { label: 'macOS' }
  const badge = count > 1 ? `1 of ${count}` : undefined
  const tile = <Icon source={paneGlyph(input.pane)} size={14} color={k.t.text} />
  const error = actError || state.ui.error || progress?.error || undefined

  if (view === 'done') {
    return (
      <CardShell testId="permission-panel" stealFocus={false}>
        <RequestHeader glyph={ICONS.window} tone="success" title={permissionGrantedTitle(input)} chip={chip} badge={badge} />
        <PhaseIn phase="done"><StatusRow tone="done" testId="permission-done" label={`${agent} is continuing.`} /></PhaseIn>
      </CardShell>
    )
  }
  if (view === 'wait') {
    return (
      <CardShell testId="permission-panel" onKey={(e) => (e.key === 'escape' ? (void stop(true), true) : false)}>
        <RequestHeader glyph={ICONS.window} tileMark={tile} title={permissionTitle(input)} chip={chip} badge={badge} error={error} />
        <PhaseIn phase="wait">
          <AppWell input={input} />
          <StatusRow testId="permission-status" label={permissionWaitingLine(input)} />
          <Hints
            left={<HintText>{input.detects ? 'Kybern checks every 2 s and continues on its own.' : 'Turn it on, then choose I’ve granted it.'}</HintText>}
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <Button variant="ghost" size="sm" testId="permission-stop" onKeyboard={keyboardAnswer} onClick={() => void stop(false)}>Stop waiting</Button>
                {input.detects
                  ? <Button size="sm" testId="permission-reopen" onClick={() => void openSystemSettings(progress?.url || input.url).catch(() => setActError(systemSettingsFailure(input.pane_label, '')))}>Open System Settings</Button>
                  : <Button size="sm" testId="permission-granted" onClick={() => void act('granted').catch((e) => setActError(actionFailed(e)))}>I’ve granted it</Button>}
              </div>
            }
          />
        </PhaseIn>
      </CardShell>
    )
  }
  const off = view === 'off'
  const meta = off ? permissionStillOffMeta(input) : `${agent}: “${input.reason}”${input.needs_app_added ? ` ${permissionPane(input.pane).name} lists only apps you add, so add ${input.app} first.` : ''}`
  return (
    <CardShell testId="permission-panel" onKey={(e) => state.onKey(e.key ?? '')}>
      <RequestHeader glyph={ICONS.window} tileMark={tile} title={off ? permissionStillOffTitle(input) : permissionTitle(input)} chip={chip} badge={badge} meta={input.reason || off ? meta : undefined} error={error} />
      <PhaseIn phase={view}>
        <AppWell input={input} />
        <ChoiceRows approval={approval} title={permissionTitle(input)} choices={choices} state={state} />
        <Hints
          left={state.ui.sending !== null ? <HintText>Opening System Settings…</HintText> : state.ui.note
            ? <><Kbd keys={['↵']} /><HintText>to send your note</HintText><HintText>·</HintText><Kbd keys={['esc']} /><HintText>to go back</HintText></>
            : <><Kbd keys={['↑', '↓']} /><HintText>to move</HintText><HintText>·</HintText><Kbd keys={['1']} /><HintText>–</HintText><Kbd keys={[String(choices.length)]} /><HintText>or</HintText><Kbd keys={['↵']} /><HintText>to choose</HintText>{input.needs_app_added && <><HintText>·</HintText><HintText>drag it into the list or use +</HintText></>}</>}
          right={state.ui.sending !== null || state.ui.note ? undefined : <CancelLink onClick={() => cancelTurn(threadId, false)} />}
        />
      </PhaseIn>
    </CardShell>
  )
}
