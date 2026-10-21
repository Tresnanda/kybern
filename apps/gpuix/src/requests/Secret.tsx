import { useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, SecretRequestInput } from '../../../../packages/kybern-client/src/types.ts'
import { SECRET_REQUEST_COPY as COPY, secretDestination } from '../../../../packages/kybern-client/src/secretRequest.ts'
import { Key01Icon } from '@hugeicons/core-free-icons'
import { glyph } from '../icons.tsx'
import { FONT_MONO } from '../theme.ts'
import { Label } from '../ui.tsx'
import { PanelBody, PromptLine, Tile } from '../transcript/Requests.tsx'
import { Button, Para, muted } from '../transcript/kit.tsx'
import { respondApproval } from '../transcript/store.ts'
import { useTheme } from '../ui.tsx'

export function SecretRequestPanel({ approval, input, count }: { approval: ApprovalRequest; input: SecretRequestInput; count: number }) {
  const t = useTheme()
  const value = useRef('')
  useEffect(() => () => { value.current = '' }, [])
  const [revealed, setRevealed] = useState(false)
  const [hasValue, setHasValue] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const respond = async (save: boolean) => {
    if (busy || (save && !value.current)) return
    setBusy(true); setError('')
    try {
      await respondApproval(approval.id, save ? { decision: 'submit', response: { secret: value.current } } : { decision: 'deny' })
      value.current = ''; setHasValue(false)
    } catch { setError('Unable to send your answer. Check the connection and try again.'); setBusy(false) }
  }
  return <PanelBody testId="secret-request-panel">
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}><Tile source={glyph(Key01Icon)} /><div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 }}>
    <PromptLine prompt={input.label} count={count} />
    {input.reason && <Para color={muted(t, .65)} size={12} style={{ marginTop: 3 }}>{input.reason}</Para>}
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>{secretDestination(input).map((part, i) => <Label key={i} color={muted(t, .7)} size={11.5} font={part.code ? FONT_MONO : undefined} style={part.code ? { backgroundColor: t.codeSurface, paddingLeft: 4, paddingRight: 4, borderRadius: 5 } : undefined}>{part.text}</Label>)}</div>
    </div></div>
    <div style={{ display: 'flex', alignItems: 'center', marginTop: 10, height: 34, borderWidth: 1, borderColor: t.borderHeavy, borderRadius: 10, paddingLeft: 10, paddingRight: 6 }}>
      <input {...{ secure: !revealed }} testId="secret-input" aria-label={input.label} readOnly={busy} onChange={e => { value.current = e.value ?? ''; setHasValue(!!value.current); setError('') }} onSubmit={() => void respond(true)} style={{ flexGrow: 1, minWidth: 0, color: t.text, fontSize: 13 }} />
      <div testId="secret-reveal" role="button" aria-label={revealed ? 'Hide value' : 'Show value'} onClick={() => setRevealed(v => !v)} style={{ paddingLeft: 8, paddingRight: 8, cursor: 'pointer' }}><Label color={t.textSecondary} size={12}>{revealed ? 'Hide' : 'Show'}</Label></div>
    </div>
    {error && <Para color={t.red} size={12}>{error}</Para>}
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
      <Para color={muted(t, .65)} size={11} style={{ flexGrow: 1 }}>{COPY.footnote}</Para>
      <Button variant="ghost" testId="secret-decline" disabled={busy} onClick={() => void respond(false)}>{COPY.decline}</Button>
      <Button swap testId="secret-save" disabled={busy || !hasValue} onClick={() => void respond(true)}>{busy ? COPY.saving : COPY.save}</Button>
    </div>
  </PanelBody>
}
