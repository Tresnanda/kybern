import { useEffect, useState } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '../../../../packages/kybern-client/src/types.ts'
import { briefProposalInput, settingsProposalInput, leadGitCardInput, COORDINATOR_CARD_COPY as COPY, gitCardCopy, cardPartsText, checksLabel, mergeMethodLabel } from '../../../../packages/kybern-client/src/coordinatorCards.ts'
import { settingValueLabel } from '../../../../packages/kybern-client/src/coordinatorSettings.ts'
import { useNav } from '../nav/store.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { keyboardAnswer } from '../requests/Panel.tsx'
import { CardShell, GLYPHS, HintText, Hints, RequestHeader } from '../requests/Card.tsx'
import { Para, muted, cachedMarkdownTheme } from '../transcript/kit.tsx'
import { Button } from '../kit/Button.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { TextArea } from '../kit/TextArea.tsx'
import { useControls } from '../kit/controls.ts'
import { errorText, respondApproval } from '../transcript/store.ts'
import { T } from '../transcript/glyphs.ts'
import { ICONS } from '../icons.tsx'
import { Label, useTheme } from '../ui.tsx'

export function CoordinatorCard({ approval, count }: { approval: ApprovalRequest; count: number }) {
  const t = useTheme()
  const c = useControls()
  const providers = useNav(s => s.providers)
  const brief = briefProposalInput(approval), settings = settingsProposalInput(approval), git = leadGitCardInput(approval)
  const [text, setText] = useState(brief?.text ?? '')
  const [accepted, setAccepted] = useState(() => new Set(settings?.changes.map(c => c.path)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const respond = async (decision: ApprovalDecision) => {
    if (busy) return
    setBusy(true); setError('')
    try { await respondApproval(approval.id, decision) } catch (e) { setError(`Unable to send your answer: ${errorText(e).replace(/\.$/, '')}. Try again.`); setBusy(false) }
  }
  const accept = () => respond(brief ? { decision: 'submit', response: { text } } : settings ? { decision: 'submit', response: { accepted: settings.changes.map(c => c.path).filter(path => accepted.has(path)) } } : { decision: 'allow_once' })
  useEffect(() => addWindowKeyHandler(e => {
    if (!brief || busy || !text.trim() || e.key !== 'enter' || !e.modifiers?.cmd) return false
    keyboardAnswer(); void accept(); return true
  }), [brief, busy, text])
  const copy = git && gitCardCopy(git)
  const checks = git?.op === 'merge_pr' ? checksLabel(git.checks) : null
  const title = brief ? brief.replaces ? COPY.briefReplaceTitle : COPY.briefTitle : settings ? COPY.settingsTitle : copy ? cardPartsText(copy.title) : approval.summary
  const glyph = brief ? T.note : settings ? ICONS.settings : T.github
  const detail = brief ? COPY.briefDetail : settings ? COPY.settingsDetail : copy ? cardPartsText(copy.detail) : ''
  return <CardShell testId="coordinator-card" stealFocus={false}>
    <RequestHeader glyph={glyph} title={title} badge={count > 1 ? `1 of ${count}` : undefined} meta={detail || undefined} />
    {brief && <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}><TextArea label="Coordinator brief" testId="coordinator-brief" value={text} onChange={v => { if (!busy) setText(v) }} minRows={4} maxRows={10} /></div>}
    {settings && <>
      {settings.reason && <Para color={muted(t)} size={12}>{settings.reason}</Para>}
      <virtual-list style={{ width: '100%', height: Math.min(240, settings.changes.length * 57) }}>
        {settings.changes.map(change => {
          const toggle = () => { if (busy) return; const next = new Set(accepted); if (!next.delete(change.path)) next.add(change.path); setAccepted(next) }
          return <div key={change.path} role="checkbox" aria-checked={accepted.has(change.path)} aria-label={change.label} tabIndex={0} testId={`coordinator-setting-${change.path}`} onClick={toggle} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') toggle() }} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 8, minHeight: 57, borderRadius: 9, cursor: 'pointer', hover: { backgroundColor: c.ink(0.04) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }}>
            <div style={{ display: 'flex', paddingTop: 1 }}><Checkbox checked={accepted.has(change.path)} disabled={busy} aria-label={change.label} style={{ pointerEvents: 'none' }} /></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
              <Label color={t.text} size={13} lineHeight={18} weight={500} style={{ pointerEvents: 'none' }}>{change.label}</Label>
              <Para color={muted(t)} size={11}>{`${settingValueLabel(change.path, change.old, providers)} → ${settingValueLabel(change.path, change.new, providers)}`}</Para>
            </div>
          </div>
        })}
      </virtual-list>
    </>}
    {git?.op === 'open_pr' && <div style={{ marginTop: 10 }}><Para color={t.text} size={13} weight={500}>{git.title}</Para><markdown source={git.body} theme={cachedMarkdownTheme(t)} style={{ userSelect: 'text', color: t.text, maxHeight: 220, overflowY: 'scroll' }} /></div>}
    {git?.op === 'merge_pr' && <Para color={checks?.tone === 'bad' ? t.red : muted(t)} size={12}>{`${checks?.text ?? 'No checks reported'} · ${mergeMethodLabel(git.method)}`}</Para>}
    {error && <Para color={t.red} size={12} style={{ marginTop: 6 }}>{error}</Para>}
    <Hints
      left={brief || git?.op === 'merge_pr' ? <HintText>{brief ? COPY.briefFootnote : COPY.mergeWarning}</HintText> : <div />}
      right={<div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        <Button variant="ghost" size="sm" onKeyboard={keyboardAnswer} testId="coordinator-decline" disabled={busy} onClick={() => void respond({ decision: 'deny' })}>{COPY.decline}</Button>
        <Button variant="primary" size="sm" swap onKeyboard={keyboardAnswer} kbd={brief ? '⌘↵' : undefined} testId="coordinator-accept" disabled={busy || (!!brief && !text.trim()) || (!!settings && !accepted.size)} onClick={() => void accept()}>{busy ? COPY.saving : brief ? COPY.briefSave : settings ? `Apply ${accepted.size} ${accepted.size === 1 ? 'change' : 'changes'}` : copy?.action}</Button>
      </div>}
    />
  </CardShell>
}
