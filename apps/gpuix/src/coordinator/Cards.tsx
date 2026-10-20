import { useEffect, useState } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '../../../../packages/kybern-client/src/types.ts'
import { briefProposalInput, settingsProposalInput, leadGitCardInput, COORDINATOR_CARD_COPY as COPY, gitCardCopy, cardPartsText, checksLabel, mergeMethodLabel } from '../../../../packages/kybern-client/src/coordinatorCards.ts'
import { settingValueLabel } from '../../../../packages/kybern-client/src/coordinatorSettings.ts'
import { useNav } from '../nav/store.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { keyboardAnswer } from '../requests/Panel.tsx'
import { PanelBody, PromptLine, Tile } from '../transcript/Requests.tsx'
import { Button, Para, muted, cachedMarkdownTheme } from '../transcript/kit.tsx'
import { errorText, respondApproval } from '../transcript/store.ts'
import { T } from '../transcript/glyphs.ts'
import { ICONS } from '../icons.tsx'
import { FONT_UI } from '../theme.ts'
import { useTheme } from '../ui.tsx'

export function CoordinatorCard({ approval, count }: { approval: ApprovalRequest; count: number }) {
  const t = useTheme()
  const providers = useNav(s => s.providers)
  const brief = briefProposalInput(approval), settings = settingsProposalInput(approval), git = leadGitCardInput(approval)
  const [text, setText] = useState(brief?.text ?? '')
  const [accepted, setAccepted] = useState(() => new Set(settings?.changes.map(c => c.path)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const respond = async (decision: ApprovalDecision) => {
    if (busy) return
    setBusy(true); setError('')
    try { await respondApproval(approval.id, decision) } catch (e) { setError(errorText(e)); setBusy(false) }
  }
  const accept = () => respond(brief ? { decision: 'submit', response: { text } } : settings ? { decision: 'submit', response: { accepted: settings.changes.map(c => c.path).filter(path => accepted.has(path)) } } : { decision: 'allow_once' })
  useEffect(() => addWindowKeyHandler(e => {
    if (!brief || busy || !text.trim() || e.key !== 'enter' || !e.modifiers?.cmd) return false
    keyboardAnswer(); void accept(); return true
  }), [brief, busy, text])
  const copy = git && gitCardCopy(git)
  const checks = git?.op === 'merge_pr' ? checksLabel(git.checks) : null
  const title = brief ? brief.replaces ? COPY.briefReplaceTitle : COPY.briefTitle : settings ? COPY.settingsTitle : copy ? cardPartsText(copy.title) : approval.summary
  return <PanelBody testId="coordinator-card">
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}><Tile source={brief ? T.note : settings ? ICONS.settings : T.github} /><div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}><PromptLine prompt={title} count={count} />
    <Para color={muted(t, .65)} size={12}>{brief ? COPY.briefDetail : settings ? COPY.settingsDetail : copy ? cardPartsText(copy.detail) : ''}</Para></div></div>
    {brief && <textarea testId="coordinator-brief" readOnly={busy} value={text} onChange={e => setText(e.value ?? '')} minRows={4} maxRows={10} style={{ width: '100%', marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: t.codeSurface, color: t.text, fontSize: 13, fontFamily: FONT_UI }} />}
    {settings && <>
      {settings.reason && <Para color={muted(t)} size={12}>{settings.reason}</Para>}
      <virtual-list style={{ width: '100%', height: Math.min(240, settings.changes.length * 57) }}>
        {settings.changes.map(change => <div key={change.path} role="checkbox" aria-checked={accepted.has(change.path)} testId={`coordinator-setting-${change.path}`} onClick={() => { if (busy) return; const next = new Set(accepted); if (!next.delete(change.path)) next.add(change.path); setAccepted(next) }} style={{ display: 'flex', flexDirection: 'column', padding: 8, minHeight: 57, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
          <Para color={t.text} size={12}>{`${accepted.has(change.path) ? '☑' : '☐'} ${change.label}`}</Para>
          <Para color={muted(t)} size={11}>{`${settingValueLabel(change.path, change.old, providers)} → ${settingValueLabel(change.path, change.new, providers)}`}</Para>
        </div>)}
      </virtual-list>
    </>}
    {git?.op === 'open_pr' && <div style={{ marginTop: 10 }}><Para color={t.text} size={13} weight={500}>{git.title}</Para><markdown source={git.body} theme={cachedMarkdownTheme(t)} style={{ userSelect: 'text', color: t.text, maxHeight: 220, overflowY: 'scroll' }} /></div>}
    {git?.op === 'merge_pr' && <Para color={checks?.tone === 'bad' ? t.red : muted(t)} size={12}>{`${checks?.text ?? 'No checks reported'} · ${mergeMethodLabel(git.method)}`}</Para>}
    {error && <Para color={t.red} size={12}>{error}</Para>}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 12 }}>
      {(brief || git?.op === 'merge_pr') && <Para color={muted(t, .65)} size={11} style={{ flexGrow: 1 }}>{brief ? COPY.briefFootnote : COPY.mergeWarning}</Para>}
      <Button variant="ghost" testId="coordinator-decline" disabled={busy} onClick={() => void respond({ decision: 'deny' })}>{COPY.decline}</Button>
      <Button testId="coordinator-accept" disabled={busy || (!!brief && !text.trim()) || (!!settings && !accepted.size)} onClick={() => void accept()}>{busy ? COPY.saving : brief ? COPY.briefSave : settings ? `Apply ${accepted.size} ${accepted.size === 1 ? 'change' : 'changes'}` : copy?.action}</Button>
    </div>
  </PanelBody>
}
