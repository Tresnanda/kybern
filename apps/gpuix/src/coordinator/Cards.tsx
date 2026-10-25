import { useEffect, useState } from 'react'
import { AiMagicIcon } from '@hugeicons/core-free-icons'
import type { ApprovalDecision, ApprovalRequest, TidyOffer } from '../../../../packages/kybern-client/src/types.ts'
import { briefProposalInput, settingsProposalInput, noteChangesProposalInput, noteChangesTitle, tidyOfferTitle, leadGitCardInput, COORDINATOR_CARD_COPY as COPY, gitCardCopy, cardPartsText, checksLabel, mergeMethodLabel } from '../../../../packages/kybern-client/src/coordinatorCards.ts'
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
import { glyph, ICONS } from '../icons.tsx'
import { NOTE_CATEGORIES } from '../../../../packages/kybern-client/src/notesHistory.ts'
import { getClient } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'

const MAGIC = glyph(AiMagicIcon)
const categoryLabel = (value: string | null | undefined) => NOTE_CATEGORIES.find((c) => c.value === value)?.label ?? ''

export function CoordinatorCard({ approval, count }: { approval: ApprovalRequest; count: number }) {
  const t = useTheme()
  const c = useControls()
  const providers = useNav(s => s.providers)
  const brief = briefProposalInput(approval), settings = settingsProposalInput(approval), notes = noteChangesProposalInput(approval), git = leadGitCardInput(approval)
  // The settings card and the note-changes card are the same list of changes the reader can untick.
  const changes = settings?.changes ?? notes?.changes
  const [text, setText] = useState(brief?.text ?? '')
  const [accepted, setAccepted] = useState(() => new Set(changes?.map(c => c.path)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const respond = async (decision: ApprovalDecision) => {
    if (busy) return
    setBusy(true); setError('')
    try { await respondApproval(approval.id, decision) } catch (e) { setError(`Unable to send your answer: ${errorText(e).replace(/\.$/, '')}. Try again.`); setBusy(false) }
  }
  const accept = () => respond(brief ? { decision: 'submit', response: { text } } : changes ? { decision: 'submit', response: { accepted: changes.map(c => c.path).filter(path => accepted.has(path)) } } : { decision: 'allow_once' })
  useEffect(() => addWindowKeyHandler(e => {
    if (!brief || busy || !text.trim() || e.key !== 'enter' || !e.modifiers?.cmd) return false
    keyboardAnswer(); void accept(); return true
  }), [brief, busy, text])
  const copy = git && gitCardCopy(git)
  const checks = git?.op === 'merge_pr' ? checksLabel(git.checks) : null
  const title = brief ? brief.replaces ? COPY.briefReplaceTitle : COPY.briefTitle : settings ? COPY.settingsTitle : notes ? noteChangesTitle(notes.changes.length) : copy ? cardPartsText(copy.title) : approval.summary
  const tile = brief || notes ? T.note : settings ? ICONS.settings : T.github
  const detail = brief ? COPY.briefDetail : settings ? COPY.settingsDetail : notes ? COPY.notesDetail : copy ? cardPartsText(copy.detail) : ''
  return <CardShell testId="coordinator-card" stealFocus={false}>
    <RequestHeader glyph={tile} title={title} badge={count > 1 ? `1 of ${count}` : undefined} meta={detail || undefined} />
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
    {notes && <>
      {notes.reason && <Para color={muted(t)} size={12}>{notes.reason}</Para>}
      <div testId="coordinator-note-changes" style={{ display: 'flex', flexDirection: 'column', maxHeight: 264, overflowY: 'scroll', marginLeft: -8, marginRight: -8, marginTop: 6 }}>
        {notes.changes.map(change => {
          const toggle = () => { if (busy) return; const next = new Set(accepted); if (!next.delete(change.path)) next.add(change.path); setAccepted(next) }
          const on = accepted.has(change.path)
          return <div key={change.path} role="checkbox" aria-checked={on} aria-label={change.note_title} tabIndex={0} testId={`coordinator-note-${change.path}`} onClick={toggle} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') toggle() }} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 8, borderRadius: 9, cursor: 'pointer', hover: { backgroundColor: c.ink(0.04) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }}>
            <div style={{ display: 'flex', paddingTop: 1 }}><Checkbox checked={on} disabled={busy} aria-label={change.note_title} style={{ pointerEvents: 'none' }} /></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexGrow: 1, minWidth: 0, opacity: on ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, pointerEvents: 'none' }}>
                <Label color={t.text} size={13} lineHeight={18} weight={500} truncate style={{ flexShrink: 1 }}>{change.note_title || 'Untitled'}</Label>
                {change.category && <Label color={t.textTertiary} size={11} lineHeight={16}>{categoryLabel(change.category)}</Label>}
              </div>
              {/* A replaced line stays visible, struck through and muted, with the new claim under it. */}
              {change.op === 'supersede' && change.supersedes && <Para color={muted(t, 0.55)} size={12} lineHeight={17} style={{ textDecoration: 'line-through', pointerEvents: 'none' }}>{change.supersedes.replace(/`/g, '')}</Para>}
              <Para color={change.op === 'supersede' ? t.text : muted(t, 0.85)} size={12} lineHeight={17} style={{ pointerEvents: 'none' }}>{change.text.replace(/^\s*[-*]\s+/, '').replace(/`/g, '')}</Para>
            </div>
          </div>
        })}
      </div>
    </>}
    {git?.op === 'open_pr' && <div style={{ marginTop: 10 }}><Para color={t.text} size={13} weight={500}>{git.title}</Para><markdown source={git.body} theme={cachedMarkdownTheme(t)} style={{ userSelect: 'text', color: t.text, maxHeight: 220, overflowY: 'scroll' }} /></div>}
    {git?.op === 'merge_pr' && <Para color={checks?.tone === 'bad' ? t.red : muted(t)} size={12}>{`${checks?.text ?? 'No checks reported'} · ${mergeMethodLabel(git.method)}`}</Para>}
    {error && <Para color={t.red} size={12} style={{ marginTop: 6 }}>{error}</Para>}
    <Hints
      left={brief || git?.op === 'merge_pr' ? <HintText>{brief ? COPY.briefFootnote : COPY.mergeWarning}</HintText> : <div />}
      right={<div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        <Button variant="ghost" size="sm" onKeyboard={keyboardAnswer} testId="coordinator-decline" disabled={busy} onClick={() => void respond({ decision: 'deny' })}>{COPY.decline}</Button>
        <Button variant="primary" size="sm" swap onKeyboard={keyboardAnswer} kbd={brief ? '⌘↵' : undefined} testId="coordinator-accept" disabled={busy || (!!brief && !text.trim()) || (!!changes && !accepted.size)} onClick={() => void accept()}>{busy ? COPY.saving : brief ? COPY.briefSave : changes ? `Apply ${accepted.size} ${accepted.size === 1 ? 'change' : 'changes'}` : copy?.action}</Button>
      </div>}
    />
  </CardShell>
}

/**
 * "5 notes may be outdated": the daemon's offer (`notes.tidy_offer`) to have an agent check the flagged notes. "Tidy notes" sends
 * the Coordinator the request (the transcript shows it as a "Tidy notes" row); "Not now" snoozes the offer for a week.
 */
export function TidyNotesCard({ projectId, offer, onOffer }: { projectId: string; offer: TidyOffer; onOffer: (offer: TidyOffer) => void }) {
  const t = useTheme()
  const [busy, setBusy] = useState<'start' | 'snooze' | null>(null)
  const [error, setError] = useState('')
  const run = async (kind: 'start' | 'snooze') => {
    if (busy) return
    setBusy(kind); setError('')
    try {
      const client = getClient()!
      if (kind === 'snooze') onOffer(await client.call('notes.tidy_snooze', { project_id: projectId }))
      else { await client.call('notes.tidy_start', { project_id: projectId }); onOffer({ ...offer, offer: false }) }
    } catch (e) { setError(`${kind === 'start' ? 'Unable to start tidying' : 'Unable to snooze this'}: ${errorText(e).replace(/\.$/, '')}. Try again.`) } finally { setBusy(null) }
  }
  return <CardShell testId="tidy-notes-card" stealFocus={false}>
    <RequestHeader glyph={MAGIC} title={tidyOfferTitle(offer.stale.length)} meta={COPY.tidyMeta} />
    {error && <Para color={t.red} size={12} style={{ marginTop: 6 }}>{error}</Para>}
    <Hints
      left={<HintText>{COPY.tidyHint}</HintText>}
      right={<div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        <Button variant="ghost" size="sm" testId="tidy-not-now" disabled={!!busy} onClick={() => void run('snooze')}>{COPY.tidyNotNow}</Button>
        <Button variant="primary" size="sm" testId="tidy-start" busy={busy === 'start'} disabled={!!busy} onClick={() => void run('start')}>{COPY.tidyAction}</Button>
      </div>}
    />
  </CardShell>
}
