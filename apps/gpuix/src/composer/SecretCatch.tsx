// The pasted-secret strip (spec `cards/spec.md` §4): a tray above the composer that appears when text inserted into the
// composer looks like an API key. "Store privately" opens the name form; "Keep as text" lets the text stay. Nothing is sent or
// saved as a draft until a choice is made, and the value never leaves this process except to the daemon's `secrets.store`.
//
// Two states in one `TrayFrame` (the composer tray's grammar): the detection line, and the form that names the variable and
// picks the file. The form checks the target as the name and file change (`secrets.target`, no value), so "Replace" and the
// `.gitignore` line say what will happen before it does.
import { useEffect, useRef, useState } from 'react'
import type { SecretsTargetResult } from '../../../../packages/kybern-client/src/types.ts'
import { toEnvName, type SecretMatch } from './secretCatcher.ts'
import { Button } from '../kit/Button.tsx'
import { TextField } from '../kit/Field.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { Icon } from '../icons.tsx'
import { G } from './glyphs.ts'
import { PickerItem, PickerMenu } from './Menu.tsx'
import { TrayFrame } from './Tray.tsx'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { projectClient, threadClient } from '../state.ts'

/** What the strip stores into: the open thread, or the project's folder for a chat that has not started. */
export interface SecretWorkspace { thread_id?: string; project_id?: string }
const workspaceClient = (workspace: SecretWorkspace) => workspace.thread_id ? threadClient(workspace.thread_id) : projectClient(workspace.project_id)

export const CATCH_FILES = ['.env.local', '.env'] as const
const NAME_RULE = /^[A-Z_][A-Z0-9_]*$/

export interface StoredSecret { name: string; file: string; gitignoreUpdated: boolean }

/** The detection line: "Looks like an API key." */
export function SecretDetected({ match, workspace, onStore, onKeep }: { match: SecretMatch; workspace: SecretWorkspace | null; onStore: () => void; onKeep: () => void }) {
  const t = useTheme()
  return (
    <TrayFrame testId="secret-catch">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0, minHeight: 32, paddingLeft: 4 }}>
        <Icon source={G.key} size={14} color={t.textSecondary} />
        <Label color={t.text} size={13} lineHeight={18} weight={500} style={{ flexShrink: 0 }}>Looks like an API key.</Label>
        <Label color={t.textTertiary} size={12} lineHeight={16} truncate style={{ flexShrink: 1, minWidth: 0 }}>{workspace ? `${capitalize(match.provider)}, pasted just now` : 'Open a project to store it privately'}</Label>
        <div style={{ flexGrow: 1 }} />
        <Button variant="ghost" size="sm" testId="secret-keep" onClick={onKeep}>Keep as text</Button>
        <Button variant="primary" size="sm" kbd="↵" testId="secret-store" disabled={!workspace} onClick={onStore}>Store privately</Button>
      </div>
    </TrayFrame>
  )
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** The form: name the variable, pick the file, and see what storing does. */
export function SecretNameForm({ match, workspace, onCancel, onStored }: { match: SecretMatch; workspace: SecretWorkspace; onCancel: () => void; onStored: (stored: StoredSecret) => void }) {
  const t = useTheme()
  const [name, setName] = useState(match.name)
  const [file, setFile] = useState<string>(CATCH_FILES[0])
  const [check, setCheck] = useState<SecretsTargetResult | { error: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const picked = useRef(false)
  const checked = useRef(false)
  const valid = NAME_RULE.test(name)

  // The first look picks the file: an existing git-ignored env file first, else `.env.local`. After the person chooses, it stays.
  useEffect(() => {
    let alive = true
    const client = workspaceClient(workspace)
    if (!client || !valid) return
    void (async () => {
      try {
        const results = await Promise.all(CATCH_FILES.map(async f => [f, await client.call('secrets.target', { ...workspace, env_key: name, file: f }).catch(() => null)] as const))
        if (!alive) return
        if (!picked.current) {
          const best = results.find(([f, r]) => f === '.env' && r?.exists && r.ignored && !r.tracked) ?? results.find(([f, r]) => f === '.env.local' && r?.exists && r.ignored && !r.tracked)
          if (best) setFile(best[0])
        }
        picked.current = true
      } catch { /* the per-file check below reports */ }
    })()
    return () => { alive = false }
    // The file is chosen once, from the guessed name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const client = workspaceClient(workspace)
    if (!client || !valid) { setCheck(null); return }
    let alive = true
    // The first look is at once (the form opens already knowing what it will do); edits of the name wait for a pause.
    const delay = checked.current ? 200 : 0
    checked.current = true
    const timer = setTimeout(() => {
      client.call('secrets.target', { ...workspace, env_key: name, file })
        .then(result => { if (alive) setCheck(result) })
        .catch(e => { if (alive) setCheck({ error: e instanceof Error ? e.message : String(e) }) })
    }, delay)
    return () => { alive = false; clearTimeout(timer) }
  }, [name, file, valid, workspace.thread_id, workspace.project_id])

  const result = check && !('error' in check) ? check : null
  const blocked = !!(check && 'error' in check) || !!result?.tracked
  const replaces = !!result?.replaces
  const addIgnore = !!result && !result.ignored && !result.tracked
  const store = async () => {
    const client = workspaceClient(workspace)
    if (!client || busy || !valid || blocked) return
    setBusy(true); setError('')
    try {
      const stored = await client.call('secrets.store', { ...workspace, env_key: name, value: match.value, file, add_to_gitignore: addIgnore })
      onStored({ name: stored.env_key, file: stored.file, gitignoreUpdated: stored.gitignore_updated })
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : 'Unable to store the key. Check the connection and try again.')
    }
  }
  // Until the first look comes back the line stays empty rather than promising what Store does.
  const message = !valid || !check ? null
    : check && 'error' in check ? check.error
    : result?.tracked ? `Git tracks \`${file}\`, so it can't hold a key. Choose another file.`
    : replaces ? `\`${file}\` already has ${name}. Storing replaces it.`
    : addIgnore ? `Git doesn't ignore \`${file}\` yet; Kybern adds it to \`.gitignore\`.`
    : `Saved to \`${file}\`, which Git ignores.`
  const failing = (check && 'error' in check) || result?.tracked
  return (
    <TrayFrame testId="secret-name">
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, paddingLeft: 6, paddingRight: 4, paddingTop: 6, paddingBottom: 4, gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 }}>
          <Icon source={G.key} size={14} color={t.textSecondary} />
          <Label color={t.text} size={13} lineHeight={18} weight={500} style={{ flexShrink: 0 }}>Store the key privately</Label>
          <div style={{ flexGrow: 1 }} />
          <Label color={t.textTertiary} size={12} lineHeight={16} truncate>The agent gets the name, never the value</Label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TextField
            label="Variable name" testId="secret-name-input" mono autoFocus value={name} invalid={!valid}
            onChange={value => { setName(value.toUpperCase()); setError('') }}
            leading={<Label color={t.textTertiary} size={12.5} font={FONT_MONO}>$</Label>}
            style={{ fontSize: 12.5 }} shell={{ flexGrow: 1, height: 28, borderRadius: 9 }}
            interceptKeys={['enter', 'escape']}
            onKeyDown={e => {
              if (e.key === 'escape') { e.preventDefault(); onCancel() }
              else if (e.key === 'enter' && !e.modifiers?.shift) { e.preventDefault(); void store() }
            }}
          />
          <PickerMenu testId="secret-file" side="top" align="end" trigger={open => <PickerChip size="sm" open={open} icon={G.file} label={`Env file ${file}`}><Label color={t.text} size={12.5} lineHeight={16} weight={500} font={FONT_MONO}>{file}</Label></PickerChip>}>
            {CATCH_FILES.map(f => (
              <PickerItem key={f} id={f} testId={`secret-file-${f}`} onSelect={() => { picked.current = true; setFile(f) }}>
                <Label color={t.text} font={FONT_MONO} size={12.5}>{f}</Label>
              </PickerItem>
            ))}
          </PickerMenu>
        </div>
        {!valid && <Label color={t.red} size={12} lineHeight={17}>Use letters, digits and underscores, and start with a letter.</Label>}
        {error && <Label color={t.red} size={12} lineHeight={17}>{error}</Label>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
          <div style={{ display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
            {message && <Label color={failing ? t.red : t.textTertiary} size={12} lineHeight={17}>{message.replaceAll('`', '')}</Label>}
          </div>
          <Button variant="ghost" size="sm" kbd="esc" testId="secret-cancel" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" kbd="↵" testId="secret-confirm" busy={busy} disabled={!valid || blocked || !check} onClick={() => void store()}>{replaces ? 'Replace' : 'Store'}</Button>
        </div>
      </div>
    </TrayFrame>
  )
}

export { toEnvName }
