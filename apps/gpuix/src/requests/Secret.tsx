import { useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, SecretRequestInput } from '../../../../packages/kybern-client/src/types.ts'
import { SECRET_REQUEST_COPY as COPY, secretDestination } from '../../../../packages/kybern-client/src/secretRequest.ts'
import { Key01Icon } from '@hugeicons/core-free-icons'
import { glyph } from '../icons.tsx'
import { FONT_MONO, FONT_UI } from '../theme.ts'
import { Label } from '../ui.tsx'
import { PanelBody, PromptLine, Tile } from '../transcript/Requests.tsx'
import { Para, muted } from '../transcript/kit.tsx'
import { Button } from '../kit/Button.tsx'
import { FieldShell } from '../kit/Field.tsx'
import { keyboardAnswer } from './Panel.tsx'
import { respondApproval } from '../transcript/store.ts'
import { useTheme } from '../ui.tsx'

export function SecretRequestPanel({ approval, input, count }: { approval: ApprovalRequest; input: SecretRequestInput; count: number }) {
  const t = useTheme()
  const value = useRef('')
  useEffect(() => () => { value.current = '' }, [])
  const [revealed, setRevealed] = useState(false)
  const [focused, setFocused] = useState(false)
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
    <FieldShell size="lg" focused={focused} style={{ marginTop: 10, paddingRight: 4 }} trailing={
      <Button variant="ghost" size="sm" testId="secret-reveal" label={revealed ? 'Hide value' : 'Show value'} onClick={() => setRevealed(v => !v)}>{revealed ? 'Hide' : 'Show'}</Button>
    }>
      <input {...{ secure: !revealed }} testId="secret-input" aria-label={input.label} readOnly={busy} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={e => { value.current = e.value ?? ''; setHasValue(!!value.current); setError('') }} onSubmit={() => void respond(true)} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, height: '100%', borderWidth: 0, fontFamily: FONT_UI, fontSize: 14, color: t.text, backgroundColor: 'rgba(0, 0, 0, 0)' }} />
    </FieldShell>
    {error && <Para color={t.red} size={12}>{error}</Para>}
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
      <Para color={muted(t, .65)} size={11} style={{ flexGrow: 1 }}>{COPY.footnote}</Para>
      <Button variant="ghost" onKeyboard={keyboardAnswer} testId="secret-decline" disabled={busy} onClick={() => void respond(false)}>{COPY.decline}</Button>
      <Button variant="primary" swap onKeyboard={keyboardAnswer} testId="secret-save" disabled={busy || !hasValue} onClick={() => void respond(true)}>{busy ? COPY.saving : COPY.save}</Button>
    </div>
  </PanelBody>
}
