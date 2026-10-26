// "New group project" (L3 sheet 2): after the group folder is chosen, the git repositories Kybern finds up to two folders
// deep, nothing ticked. "Add folder…" adds a deeper repository (it must be inside the group folder). The helper line above
// the buttons says what is missing or what the group will be; the primary stays disabled until the selection is valid.
// ⌘↵ submits, Esc cancels. Busy: "Adding…", the button keeps its width and the sheet stays until the project exists.
import { useGpuix, useWindowSize } from '@gpuix/react'
import { homedir } from 'node:os'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { GROUP_COPY, memberSelectionError, memberSelectionHelper, orderMemberPaths } from '../../../../packages/kybern-client/src/groups.ts'
import type { ProjectsScanReposResult, RepoCandidate } from '../../../../packages/kybern-client/src/types.ts'
import { Button } from '../kit/Button.tsx'
import { FieldShell, TextField } from '../kit/Field.tsx'
import { Checklist, ChecklistHeader } from '../groups/Checklist.tsx'
import { folderName, isSelectable, mergeCandidates, orderCandidates, relativeInside, tildify, toggled } from '../groups/model.ts'
import { Icon } from '../icons.tsx'
import { errorText } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { Dialog, useDialogClose } from '../nav/overlay.tsx'
import { activeEnvironment } from '../shell/environment.ts'
import { addProjectToCurrentSpace } from '../spaces/add.ts'
import { getClient, selectDraft } from '../state.ts'
import { setNav } from '../nav/store.ts'
import { Label, useTheme } from '../ui.tsx'
import { showDialog } from './store.ts'
import { isPrimary } from '../platform/keys.ts'

/** What the sheet shows before (or instead of) a live scan: fixtures pass one in. */
export interface GroupSheetSeed {
  scan: ProjectsScanReposResult | null
  selected?: string[]
  addError?: string
}

export function GroupProject({ path, close, seed }: { path: string; close: () => void; seed?: GroupSheetSeed }) {
  return (
    <Dialog onClose={close} width={512} testId="group-sheet">
      <GroupSheet path={path} close={close} seed={seed} />
    </Dialog>
  )
}

function GroupSheet({ path, close, seed }: { path: string; close: () => void; seed?: GroupSheetSeed }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const window = useWindowSize({ intervalMs: 250 })
  const exit = useDialogClose()
  const local = activeEnvironment().local
  const [client] = useState(() => getClient())
  const [scan, setScan] = useState<ProjectsScanReposResult | null>(seed?.scan ?? null)
  const [candidates, setCandidates] = useState<RepoCandidate[]>(() => orderCandidates(seed?.scan?.candidates ?? []))
  const [selected, setSelected] = useState<string[]>(seed?.selected ?? [])
  const [includes, setIncludes] = useState<string[]>([])
  const [name, setName] = useState(seed?.scan?.name ?? folderName(path))
  const [loading, setLoading] = useState(!seed)
  const [addError, setAddError] = useState(seed?.addError ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const nameEdited = useRef(false)

  useEffect(() => {
    if (seed || !client) return
    let live = true
    client.call('projects.scan_repos', { path }).then((result) => {
      if (!live) return
      setScan(result)
      setCandidates(orderCandidates(result.candidates))
      if (!nameEdited.current) setName(result.name)
    }, (e) => { if (live) setError(errorText(e)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [client, path])

  const folder = scan?.path ?? path
  const shownFolder = local ? tildify(folder, homedir()) : folder
  const group = scan?.name ?? folderName(folder)
  const invalid = memberSelectionError(selected)
  const existing = scan?.existing_project_id ?? null
  const canAdd = !!scan && !invalid && !existing && !busy && name.trim().length > 0

  const change = async () => {
    if (!local) return showDialog({ kind: 'project', group: true })
    const paths = await renderer?.promptForPaths?.({ directories: true, files: false, prompt: GROUP_COPY.chooseGroupFolder })
    if (paths?.[0] && paths[0] !== folder) showDialog({ kind: 'group', path: paths[0] })
  }

  const addFolder = async () => {
    if (!client) return
    const paths = await renderer?.promptForPaths?.({ directories: true, files: false, prompt: GROUP_COPY.addFolder.replace('…', '') })
    const picked = paths?.[0]
    if (!picked) return
    const relative = relativeInside(folder, picked)
    if (relative === null) return setAddError(GROUP_COPY.outsideFolderError(group))
    if (candidates.some((c) => c.path === relative)) {
      setAddError('')
      if (!selected.includes(relative) && candidates.find((c) => c.path === relative && isSelectable(c))) setSelected(toggled(selected, relative))
      return
    }
    const include = [...includes, relative]
    try {
      const result = await client.call('projects.scan_repos', { path: folder, include })
      if (getClient() !== client) return
      const rejected = result.rejected?.find((r) => r.path === relative || r.path === picked)
      if (rejected) return setAddError(rejected.reason)
      setAddError('')
      setIncludes(include)
      const merged = mergeCandidates(candidates, result.candidates, [relative])
      setCandidates(merged)
      // The user picked this folder: it arrives ticked ("Added"), unless it can't be a member.
      if (merged.find((c) => c.path === relative && isSelectable(c))) setSelected((prev) => (prev.includes(relative) ? prev : toggled(prev, relative)))
    } catch (e) { setAddError(errorText(e)) }
  }

  const submit = async () => {
    if (!canAdd) return
    setBusy(true); setError('')
    try {
      const trimmed = name.trim()
      await addProjectToCurrentSpace(folder, { kind: 'group', members: orderMemberPaths(selected), ...(trimmed !== group ? { name: trimmed } : {}) })
      if (getClient() !== client) return
      close()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const openExisting = () => {
    if (!existing) return
    setNav({ page: 'home' })
    selectDraft(existing)
    close()
  }

  return (
    <div
      onKeyDown={(e) => { if (e.key === 'enter' && isPrimary(e.modifiers)) void submit() }}
      style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingLeft: 20, paddingRight: 20, paddingTop: 20, paddingBottom: 16 }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Label color={t.text} size={17} lineHeight={22} weight={600}>{GROUP_COPY.newGroupTitle}</Label>
        <Label color={t.textSecondary} size={13} lineHeight={19}>{GROUP_COPY.newGroupSubtitle}</Label>
      </div>

      <Field label={GROUP_COPY.groupFolder}>
        <FieldShell
          testId="group-folder"
          leading={<Icon source={N.folders} size={14} color={t.textSecondary} />}
          trailing={<Button testId="group-folder-change" variant="ghost" size="sm" onClick={() => void change()}>{GROUP_COPY.change}</Button>}
          style={{ paddingRight: 4 }}
        >
          <Label color={t.text} size={13} lineHeight={18} truncate style={{ flexGrow: 1, minWidth: 0 }}>{shownFolder}</Label>
        </FieldShell>
      </Field>

      <Field label={GROUP_COPY.name}>
        <TextField testId="group-name" label={GROUP_COPY.name} value={name} onChange={(value) => { nameEdited.current = true; setName(value) }} onSubmit={(e) => { if (isPrimary(e.modifiers)) void submit() }} width="100%" />
      </Field>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ChecklistHeader selected={selected.length} total={loading ? null : candidates.length} />
        <Checklist
          maxHeight={Math.max(128, Math.min(420, window.height - 440))}
          candidates={candidates}
          selected={selected}
          loading={loading}
          onToggle={(p) => { setSelected(toggled(selected, p)); setError('') }}
          empty={{ title: GROUP_COPY.nothingFoundTitle(group), body: GROUP_COPY.nothingFoundBody }}
        />
        {loading && <Label color={t.textTertiary} size={12} lineHeight={16} style={{ paddingLeft: 2 }}>{GROUP_COPY.scanning(group)}</Label>}
        {local && (
          <div style={{ display: 'flex' }}>
            <Button testId="group-add-folder" variant="ghost" size="sm" icon={N.plus} onClick={() => void addFolder()}>{GROUP_COPY.addFolder}</Button>
          </div>
        )}
        {addError && <Label color={t.red} size={12} lineHeight={17} style={{ paddingLeft: 2 }}>{addError}</Label>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {existing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 2 }}>
            <Label color={t.textSecondary} size={12} lineHeight={17}>{GROUP_COPY.alreadyProject(group)}</Label>
            <Button testId="group-open-existing" variant="ghost" size="sm" onClick={openExisting}>{GROUP_COPY.openIt}</Button>
          </div>
        ) : !loading && (
          <Label color={invalid ? t.textTertiary : t.textSecondary} size={12} lineHeight={17} style={{ paddingLeft: 2 }}>{memberSelectionHelper(selected)}</Label>
        )}
        {error && <Label color={t.red} size={12} lineHeight={17} style={{ paddingLeft: 2 }}>{error}</Label>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button testId="group-cancel" variant="secondary" onClick={() => (exit ? exit() : close())}>{GROUP_COPY.cancel}</Button>
          <Button testId="group-add" variant="primary" kbd="⌘↵" busy={busy} swap disabled={!canAdd && !busy} onClick={() => void submit()}>{busy ? GROUP_COPY.adding : GROUP_COPY.addGroup}</Button>
        </div>
      </div>
    </div>
  )
}

/** A field with its label above (12/500, secondary). */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Label color={t.textSecondary} size={12} lineHeight={16} weight={500} style={{ paddingLeft: 2 }}>{label}</Label>
      {children}
    </div>
  )
}
