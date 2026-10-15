import { spawn } from 'node:child_process'
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

/** GPUIX 0.10 has no secure editor. Use AppKit's secure prompt; never place the
 * value in GPUIX's editable/accessibility tree, a draft, a toast, or a log. */
function readSecureValue(label: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const script = 'on run argv\ntry\nset result to display dialog (item 1 of argv) default answer "" with hidden answer buttons {"Cancel", "Use value"} default button "Use value"\nreturn text returned of result\non error number -128\nreturn ""\nend try\nend run'
    const child = spawn('/usr/bin/osascript', ['-e', script, label], { stdio: ['ignore', 'pipe', 'pipe'], signal })
    let value = ''
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { value += chunk })
    child.on('error', () => { value = ''; reject(new Error('Unable to open secure entry. Try again.')) })
    child.on('close', code => { if (code !== 0) { value = ''; reject(new Error('Unable to open secure entry. Try again.')); return }; const answer = value.replace(/\n$/, ''); value = ''; resolve(answer || null) })
  })
}

export function SecretRequestPanel({ approval, input, count }: { approval: ApprovalRequest; input: SecretRequestInput; count: number }) {
  const t = useTheme()
  const value = useRef('')
  const prompt = useRef<AbortController | null>(null)
  useEffect(() => () => { value.current = ''; prompt.current?.abort() }, [])
  const [hasValue, setHasValue] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const enter = async () => {
    setBusy(true); setError('')
    try { prompt.current = new AbortController(); const answer = await readSecureValue(input.label, prompt.current.signal); if (answer !== null && !prompt.current.signal.aborted) { value.current = answer; setHasValue(true) } }
    catch { setError('Unable to open secure entry. Try again.') }
    finally { setBusy(false) }
  }
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
      <Button variant="chrome-outline" testId="secret-enter" disabled={busy} onClick={() => void enter()}>{hasValue ? 'Replace value…' : 'Enter value securely…'}</Button>
      {hasValue && <Para color={muted(t)} size={12}>Value ready to save</Para>}
    </div>
    {error && <Para color={t.red} size={12}>{error}</Para>}
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
      <Para color={muted(t, .65)} size={11} style={{ flexGrow: 1 }}>{COPY.footnote}</Para>
      <Button variant="ghost" testId="secret-decline" disabled={busy} onClick={() => void respond(false)}>{COPY.decline}</Button>
      <Button testId="secret-save" disabled={busy || !hasValue} onClick={() => void respond(true)}>{busy ? COPY.saving : COPY.save}</Button>
    </div>
  </PanelBody>
}
