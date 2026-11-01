// Settings › Agent providers › Antigravity (ADE-111). One account per machine, two ways in: a Gemini API key first (the provider
// environment `GEMINI_API_KEY`, which the daemon keeps in its secret store), then Google sign-in through `agy` in a terminal,
// behind the one-time notice.
import { useState } from 'react'
import { GEMINI_API_KEY_ENV } from '../../../../packages/kybern-client/src/antigravity.ts'
import { requestAntigravitySignIn } from '../antigravity/notice.ts'
import { showDialog } from '../dialogs/store.ts'
import { Button } from '../kit/Button.tsx'
import { Switch } from '../kit/Switch.tsx'
import { TextField } from '../kit/Field.tsx'
import { errorText } from '../nav/actions.ts'
import { useNav } from '../nav/store.ts'
import { toast } from '../shell/toasts.tsx'
import { updateProviderSettings, useAccounts } from '../usage/accounts.ts'
import { Row, Section } from './controls.tsx'
import { latestError, latestSettings, updateSettings, useSettings } from './store.ts'

export function AntigravitySetup() {
  const available = useNav((s) => s.providers.some((p) => p.kind === 'antigravity'))
  const { settings, saving } = useSettings()
  const accounts = useAccounts('antigravity')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  if (!available) return null
  const hasKey = !!settings?.providers.antigravity?.env[GEMINI_API_KEY_ENV]
  const email = accounts.find((a) => a.status === 'signed_in')?.identity?.email
  const signedIn = accounts.some((a) => a.status === 'signed_in')

  const writeKey = async (value: string | null) => {
    setBusy(true)
    try {
      await updateProviderSettings('antigravity', (current) => {
        const env = { ...current.env }
        if (value) env[GEMINI_API_KEY_ENV] = value
        else delete env[GEMINI_API_KEY_ENV]
        return { ...current, env }
      })
      setKey('')
      toast.success(value ? 'Gemini API key saved' : 'Gemini API key removed')
    } catch (error) {
      toast.error('Unable to update the Gemini API key', { description: `${errorText(error)} Check the connection, then try again.` })
    } finally {
      setBusy(false)
    }
  }

  const toolsOn = settings?.antigravity?.kybern_tools ?? false
  const setTools = async (kybern_tools: boolean) => {
    await updateSettings({ antigravity: { ...(latestSettings()?.antigravity ?? {}), kybern_tools } })
    // The daemon refuses the switch when another program already uses the name `kybern`; say why.
    const failed = latestError()
    if (failed) toast.error('Unable to change Kybern tools', { description: failed.replace(/^.*?try again\.\s*(Error:\s*)?/, '') })
  }

  return (
    <Section title="Antigravity">
      <Row title="Use a Gemini API key" description={hasKey ? 'A key is saved on this machine. Antigravity uses it for every chat.' : 'Paste a key from Google AI Studio. It stays on this machine.'}>
        {hasKey ? (
          <Button testId="antigravity-key-remove" disabled={busy} onClick={() => void writeKey(null)}>Remove key</Button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TextField testId="antigravity-key" label="Gemini API key" secure placeholder="AIza…" value={key} onChange={setKey} onSubmit={() => { if (key.trim() && !busy) void writeKey(key.trim()) }} width={200} />
            <Button testId="antigravity-key-save" variant="primary" busy={busy} disabled={busy || !key.trim()} onClick={() => void writeKey(key.trim())}>Save key</Button>
          </div>
        )}
      </Row>
      <Row title="Sign in with Google" description={signedIn ? (email ? `Signed in as ${email}` : 'Signed in') : 'Opens Antigravity in a terminal so you can finish in your browser.'}>
        <Button testId="antigravity-signin" variant={signedIn ? 'secondary' : 'primary'} onClick={() => requestAntigravitySignIn(() => showDialog({ kind: 'account', provider: 'antigravity' }))}>
          {signedIn ? 'Sign in again' : 'Sign in with Google'}
        </Button>
      </Row>
      <Row title="Kybern tools" description="Lets Antigravity use Kybern's notes, tasks and agents. Kybern adds one entry, kybern, to Antigravity's MCP servers.">
        <Switch aria-label="Kybern tools" testId="antigravity-kybern-tools" checked={toolsOn} disabled={saving} onCheckedChange={(on) => void setTools(on)} />
      </Row>
    </Section>
  )
}
