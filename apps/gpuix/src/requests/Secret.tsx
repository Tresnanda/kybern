import { useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, SecretRequestInput } from '../../../../packages/kybern-client/src/types.ts'
import { SECRET_REQUEST_COPY as COPY, secretDestination } from '../../../../packages/kybern-client/src/secretRequest.ts'
import { FONT_MONO, FONT_UI } from '../theme.ts'
import { Button } from '../kit/Button.tsx'
import { FieldShell } from '../kit/Field.tsx'
import { T } from '../transcript/glyphs.ts'
import { respondApproval } from '../transcript/store.ts'
import { Label } from '../ui.tsx'
import { CardShell, HintText, Hints, RequestBody, RequestHeader, useCardTokens } from './Card.tsx'
import { keyboardAnswer } from './Panel.tsx'

/** A blocking form: the field, where the value goes and the two buttons. Esc is ignored so a stray key never drops a typed value. */
export function SecretRequestPanel({ approval, input, count }: { approval: ApprovalRequest; input: SecretRequestInput; count: number }) {
  const k = useCardTokens()
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
  return (
    <CardShell testId="secret-request-panel" stealFocus={false}>
      <RequestHeader glyph={T.key} title={input.label} chip={{ label: input.file, mono: true }} badge={count > 1 ? `1 of ${count}` : undefined} meta={input.reason || undefined} />
      <RequestBody>
      <FieldShell size="lg" focused={focused} style={{ marginTop: 12, paddingRight: 4 }} trailing={
        <Button variant="ghost" size="sm" testId="secret-reveal" label={revealed ? 'Hide value' : 'Show value'} onClick={() => setRevealed(v => !v)}>{revealed ? 'Hide' : 'Show'}</Button>
      }>
        <input {...{ secure: !revealed }} testId="secret-input" aria-label={input.label} readOnly={busy} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={e => { value.current = e.value ?? ''; setHasValue(!!value.current); setError('') }} onSubmit={() => void respond(true)} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, height: '100%', borderWidth: 0, fontFamily: FONT_UI, fontSize: 14, color: k.t.text, backgroundColor: 'rgba(0, 0, 0, 0)' }} />
      </FieldShell>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, marginTop: 8, paddingLeft: 2 }}>
        {secretDestination(input).map((part, i) => (
          <Label key={i} color={k.t.textTertiary} size={11.5} lineHeight={18} font={part.code ? FONT_MONO : undefined} style={part.code ? { backgroundColor: k.chipBg, paddingLeft: 4, paddingRight: 4, borderRadius: 5, color: k.t.text } : undefined}>{part.text}</Label>
        ))}
        <Label color={k.t.textTertiary} size={11.5} lineHeight={18}>{' Git ignores this file.'}</Label>
      </div>
      </RequestBody>
      <Hints
        error={error}
        left={<HintText>{COPY.footnote}</HintText>}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" onKeyboard={keyboardAnswer} testId="secret-decline" disabled={busy} onClick={() => void respond(false)}>{COPY.decline}</Button>
            <Button variant="primary" size="sm" swap onKeyboard={keyboardAnswer} kbd="↵" testId="secret-save" disabled={busy || !hasValue} onClick={() => void respond(true)}>{busy ? COPY.saving : COPY.save}</Button>
          </div>
        }
      />
    </CardShell>
  )
}
