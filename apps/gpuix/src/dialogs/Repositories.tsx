// "Repositories" (L3 sheet 3 with the user's §8 answers): the members of a group project, edited in place. Every change is
// one `projects.update` with the full list and saves at once; Done only closes. Removing is reversible, so it acts at
// once and offers Undo (8 s, or until the dialog closes) instead of a confirmation. The primary is the group folder when
// it is a member, else the first by path: it is shown, never chosen (no "Make primary"). "Also copy into worktrees" lists
// the top-level entries of the group folder the user picked for new worktree containers; nothing is pre-picked.
import { useGpuix, useWindowSize } from '@gpuix/react'
import { homedir } from 'node:os'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  GROUP_COPY,
  canRemoveMember,
  instructionsCreatedText,
  memberMissingError,
  memberMissingLabel,
  memberNotGitError,
  memberSelectionError,
  orderMemberPaths,
} from '../../../../packages/kybern-client/src/groups.ts'
import type { MemberState, Project, ProjectMember, RepoCandidate } from '../../../../packages/kybern-client/src/types.ts'
import { Badge } from '../kit/Badge.tsx'
import { useEscapeLayer } from '../kit/AlertDialog.tsx'
import { Button } from '../kit/Button.tsx'
import { RADIUS, useControls } from '../kit/controls.ts'
import { IconButton } from '../kit/IconButton.tsx'
import { TokenChip } from '../kit/TokenChip.tsx'
import { Checklist, ChecklistHeader } from '../groups/Checklist.tsx'
import { copyChoices, folderName, isSelectable, mergeCandidates, nonMembers, orderCandidates, relativeInside, remoteSlug, tildify, toggled } from '../groups/model.ts'
import { loadMemberStatus, updateGroup, useMemberStatus } from '../groups/store.ts'
import { Icon } from '../icons.tsx'
import { Rise } from '../motion/kit.tsx'
import { errorText } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { Dialog, DialogHeader, Menu, MenuItem, MenuSeparator, useDialogClose } from '../nav/overlay.tsx'
import { activeEnvironment } from '../shell/environment.ts'
import { toast } from '../shell/toasts.tsx'
import { addProjectToCurrentSpace } from '../spaces/add.ts'
import { getClient, useApp } from '../state.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { openQuietly, osLabels, revealQuietly } from '../platform/os.ts'
import { isPrimary } from '../platform/keys.ts'

const UNDO_MS = 8000

export function Repositories({ projectId, close }: { projectId: string; close: () => void }) {
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  // The project left (removed, another environment): nothing to edit.
  useEffect(() => { if (!project) close() }, [project])
  if (!project) return null
  return (
    <Dialog onClose={close} width={512} testId="repositories">
      <RepositoriesBody project={project} close={close} />
    </Dialog>
  )
}

function RepositoriesBody({ project, close }: { project: Project; close: () => void }) {
  const [mode, setMode] = useState<'list' | 'add'>('list')
  return mode === 'add'
    ? <AddRepositories project={project} onDone={() => setMode('list')} />
    : <MemberList project={project} close={close} onAdd={() => setMode('add')} />
}

function MemberList({ project, close, onAdd }: { project: Project; close: () => void; onAdd: () => void }) {
  const t = useTheme()
  const c = useControls()
  const { renderer } = useGpuix()
  const exit = useDialogClose()
  const local = activeEnvironment().local
  const status = useMemberStatus(project.id)
  const [error, setError] = useState('')
  const [removed, setRemoved] = useState<{ name: string; before: string[] } | null>(null)
  const [creating, setCreating] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  useEscapeLayer(copyOpen)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { void loadMemberStatus(project.id, true) }, [project.id])
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current) }, [])

  const members = project.members ?? []
  const paths = members.map((m) => m.path)
  const folder = local ? tildify(project.path, homedir()) : project.path
  const group = folderName(project.path)
  const stateOf = (path: string): MemberState | undefined => status?.members.find((m) => m.path === path)
  const atMinimum = !canRemoveMember(members.length)
  const broken = members.find((m) => m.status !== 'ok')

  const save = async (next: string[]) => {
    setError('')
    try { await updateGroup(project.id, { members: orderMemberPaths(next) }) } catch (e) { setError(errorText(e)); throw e }
  }
  const remove = async (member: ProjectMember) => {
    const before = paths
    try { await save(paths.filter((p) => p !== member.path)) } catch { return }
    setRemoved({ name: member.name, before })
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setRemoved(null), UNDO_MS)
  }
  const undo = async () => {
    if (!removed) return
    const before = removed.before
    setRemoved(null)
    await save(before).catch(() => {})
  }
  const locate = async (member: ProjectMember) => {
    const picked = (await renderer?.promptForPaths?.({ directories: true, files: false, prompt: GROUP_COPY.locate.replace('…', '') }))?.[0]
    if (!picked) return
    const relative = relativeInside(project.path, picked)
    if (relative === null) return setError(GROUP_COPY.outsideFolderError(group))
    await save(paths.map((p) => (p === member.path ? relative : p))).catch(() => {})
  }
  const createFiles = async () => {
    const client = getClient()
    if (!client || creating) return
    setCreating(true); setError('')
    try {
      const result = await client.call('projects.instructions.create', { project_id: project.id })
      toast(instructionsCreatedText(result.created, group))
      void loadMemberStatus(project.id, true)
    } catch (e) { setError(errorText(e)) } finally { setCreating(false) }
  }
  const reveal = (path: string) => { if (local) revealQuietly(path) }
  const openFile = (path: string) => { if (local) openQuietly(path) }
  const absolute = (member: string) => (member === '.' ? project.path : `${project.path}/${member}`)

  const shared = status ? [status.agents_md && 'AGENTS.md', status.claude_md && 'CLAUDE.md'].filter((f): f is string => !!f) : []
  const copy = project.worktree_copy ?? []
  const choices = copyChoices(status?.copy_candidates ?? [], copy, paths)
  const saveCopy = (next: string[]) => updateGroup(project.id, { worktree_copy: next }).catch((e) => setError(errorText(e)))

  return (
    <>
      <DialogHeader title={GROUP_COPY.repositories} description={`${project.name} · ${folder}`} onClose={close} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: 4 }}>
        <div testId="repositories-list" style={{ display: 'flex', flexDirection: 'column', borderRadius: RADIUS.lg, borderWidth: 1, borderColor: t.borderLight, overflow: 'hidden' }}>
          {members.map((member, i) => (
            <MemberRow
              key={member.path}
              member={member}
              state={stateOf(member.path)}
              primary={i === 0}
              first={i === 0}
              folder={folder}
              local={local}
              atMinimum={atMinimum}
              onRemove={() => void remove(member)}
              onLocate={() => void locate(member)}
              onReveal={() => reveal(absolute(member.path))}
              onOwnProject={() => void addProjectToCurrentSpace(absolute(member.path)).catch((e) => setError(errorText(e)))}
            />
          ))}
        </div>
        <div style={{ display: 'flex' }}>
          <Button testId="repositories-add" variant="ghost" size="sm" icon={N.plus} onClick={onAdd}>{GROUP_COPY.addRepositories}</Button>
        </div>
        {removed && (
          <Rise kind="row">
            <div testId="repositories-undo" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 36, paddingLeft: 12, paddingRight: 4, borderRadius: RADIUS.md, backgroundColor: c.ink(0.04) }}>
              <Label color={t.text} size={13} lineHeight={18} truncate style={{ flexGrow: 1 }}>{GROUP_COPY.removed(removed.name)}</Label>
              <Button testId="repositories-undo-button" variant="ghost" size="sm" onClick={() => void undo()}>{GROUP_COPY.undo}</Button>
            </div>
          </Rise>
        )}
        {broken && !error && <Label color={t.red} size={12} lineHeight={17}>{broken.status === 'missing' ? memberMissingError(broken.name, folder) : memberNotGitError(broken.name)}</Label>}
        {error && <Label color={t.red} size={12} lineHeight={17}>{error}</Label>}
        <Label color={t.textTertiary} size={12} lineHeight={17}>{GROUP_COPY.membersNote}</Label>

        <Section title={GROUP_COPY.sharedInstructions}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 48, paddingLeft: 12, paddingRight: 8, paddingTop: 8, paddingBottom: 8, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: t.borderLight }}>
            <Icon source={N.file} size={16} color={t.textSecondary} />
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
              <Label color={t.text} size={13} lineHeight={18}>{shared.length ? shared.join(', ') : GROUP_COPY.notSetUp}</Label>
              {shared.length
                ? <Label color={t.textTertiary} size={11.5} lineHeight={16} font={FONT_MONO}>{`${group}/`}</Label>
                : <Label color={t.textSecondary} size={12} lineHeight={17}>{GROUP_COPY.notSetUpDetail(group)}</Label>}
            </div>
            {status && (shared.length === 2
              ? local && <Button testId="repositories-open-agents" variant="ghost" size="sm" onClick={() => openFile(`${project.path}/AGENTS.md`)}>{GROUP_COPY.openAgentsMd}</Button>
              : <Button testId="repositories-create-files" size="sm" busy={creating} onClick={() => void createFiles()}>{creating ? GROUP_COPY.creating : GROUP_COPY.createFiles}</Button>)}
          </div>
        </Section>

        <Section title={GROUP_COPY.alsoCopy} detail={GROUP_COPY.alsoCopyDetail(group)}>
          <div testId="repositories-copy" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            {copy.map((name) => (
              <TokenChip key={name} testId={`repositories-copy-${name}`} lead={<Icon source={status?.copy_candidates?.find((e) => e.name === name)?.is_dir === false ? N.file : N.folder} size={12} color={t.textSecondary} />} onRemove={() => void saveCopy(copy.filter((n) => n !== name))} removeLabel={`Stop copying ${name}`}>{name}</TokenChip>
            ))}
            {copy.length === 0 && <Label color={t.textTertiary} size={12} lineHeight={24}>{GROUP_COPY.alsoCopyEmpty}</Label>}
            <Menu testId="repositories-copy-add" open={copyOpen} onOpenChange={setCopyOpen} priority={7} align="start" width={240} trigger={(open) => <Button variant="ghost" size="sm" icon={N.plus} chevron={false} disabled={!choices.length} trailing={null} label={GROUP_COPY.alsoCopyAdd} style={open ? { backgroundColor: c.ghost.hover } : undefined}>{GROUP_COPY.alsoCopyAdd}</Button>}>
              {choices.map((entry) => (
                <MenuItem key={entry.name} id={entry.name} testId={`repositories-copy-choice-${entry.name}`} icon={entry.is_dir ? N.folder : N.file} label={entry.is_dir ? `${entry.name}/` : entry.name} onSelect={() => void saveCopy([...copy, entry.name].sort())} />
              ))}
            </Menu>
          </div>
        </Section>

        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
          <Button testId="repositories-done" variant="primary" onClick={() => (exit ? exit() : close())}>{GROUP_COPY.done}</Button>
        </div>
      </div>
    </>
  )
}

function Section({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 2 }}>
        <Label color={t.textSecondary} size={12} lineHeight={16} weight={500}>{title}</Label>
        {detail && <Label color={t.textTertiary} size={12} lineHeight={17}>{detail}</Label>}
      </div>
      {children}
    </div>
  )
}

function MemberRow({ member, state, primary, first, folder, local, atMinimum, onRemove, onLocate, onReveal, onOwnProject }: {
  member: ProjectMember
  state: MemberState | undefined
  primary: boolean
  first: boolean
  folder: string
  local: boolean
  atMinimum: boolean
  onRemove: () => void
  onLocate: () => void
  onReveal: () => void
  onOwnProject: () => void
}) {
  const t = useTheme()
  const c = useControls()
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // An open menu is the innermost overlay: a press in it, or Escape, must not close the dialog.
  useEscapeLayer(menuOpen)
  const missing = (state?.status ?? member.status) !== 'ok'
  const sub = missing ? memberMissingLabel(folder) : remoteSlug(state?.remote_url) ?? member.path
  return (
    <div
      testId={`repositories-member-${member.path}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 50, paddingLeft: 12, paddingRight: 8, paddingTop: 7, paddingBottom: 7, ...(first ? {} : { borderTopWidth: 1, borderColor: t.borderLight }), ...(hover || menuOpen ? { backgroundColor: c.ink(0.03) } : {}) }}
    >
      <Icon source={missing ? N.alert : N.repo} size={16} color={missing ? t.warning : t.textSecondary} />
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Label color={missing ? t.textSecondary : t.text} size={13} lineHeight={18} weight={500} truncate>{member.name}</Label>
          {primary && <Badge variant="info" size="sm">{GROUP_COPY.primary}</Badge>}
        </div>
        <Label color={missing ? t.warning : t.textTertiary} size={missing ? 12 : 11.5} lineHeight={16} font={missing ? undefined : FONT_MONO} truncate>{sub}</Label>
      </div>
      {missing ? (
        local && <Button testId={`repositories-locate-${member.path}`} variant="ghost" size="sm" onClick={onLocate}>{GROUP_COPY.locate}</Button>
      ) : state?.branch ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, maxWidth: 150 }}>
          <Icon source={N.branch} size={12} color={t.textTertiary} />
          <Label color={t.textTertiary} size={12} lineHeight={16} font={state.detached ? FONT_MONO : undefined} truncate>{state.branch}</Label>
        </div>
      ) : null}
      <div style={{ display: 'flex', opacity: hover || menuOpen ? 1 : 0 }}>
        <Menu open={menuOpen} onOpenChange={setMenuOpen} priority={7} align="end" width={224} testId={`repositories-menu-${member.path}`} trigger={() => <IconButton tabIndex={-1} size="sm" icon={N.ellipsis} label={`Actions for ${member.name}`} active={menuOpen} />}>
          {local && <MenuItem id="reveal" icon={N.folder} label={osLabels().reveal} disabled={missing} onSelect={onReveal} />}
          <MenuItem id="own" icon={N.plus} label={GROUP_COPY.addAsOwnProject} disabled={missing} onSelect={onOwnProject} />
          <MenuSeparator />
          <MenuItem id="remove" testId={`repositories-remove-${member.path}`} icon={N.x} label={GROUP_COPY.removeFromGroup} destructive={!atMinimum} disabled={atMinimum} description={atMinimum ? GROUP_COPY.minimumReason : undefined} onSelect={onRemove} />
        </Menu>
      </div>
    </div>
  )
}

/** "Add repositories to <project>" (sheet 3F): the group folder's repositories that aren't members, nothing ticked. */
function AddRepositories({ project, onDone }: { project: Project; onDone: () => void }) {
  const t = useTheme()
  const window = useWindowSize({ intervalMs: 250 })
  const { renderer } = useGpuix()
  const local = activeEnvironment().local
  const [client] = useState(() => getClient())
  const members = (project.members ?? []).map((m) => m.path)
  const [candidates, setCandidates] = useState<RepoCandidate[]>([])
  const [includes, setIncludes] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const folder = local ? tildify(project.path, homedir()) : project.path
  const group = folderName(project.path)

  useEffect(() => {
    if (!client) return
    let live = true
    client.call('projects.scan_repos', { path: project.path }).then(
      (result) => { if (live) setCandidates(orderCandidates(nonMembers(result.candidates, members))) },
      (e) => { if (live) setError(errorText(e)) },
    ).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [client, project.path])

  const addFolder = async () => {
    if (!client) return
    const picked = (await renderer?.promptForPaths?.({ directories: true, files: false, prompt: GROUP_COPY.addFolder.replace('…', '') }))?.[0]
    if (!picked) return
    const relative = relativeInside(project.path, picked)
    if (relative === null) return setError(GROUP_COPY.outsideFolderError(group))
    if (members.includes(relative)) return setError('')
    const include = [...includes, relative]
    try {
      const result = await client.call('projects.scan_repos', { path: project.path, include })
      const rejected = result.rejected?.find((r) => r.path === relative || r.path === picked)
      if (rejected) return setError(rejected.reason)
      setError('')
      setIncludes(include)
      const merged = mergeCandidates(candidates, nonMembers(result.candidates, members), [relative])
      setCandidates(merged)
      if (merged.find((c) => c.path === relative && isSelectable(c))) setSelected((prev) => (prev.includes(relative) ? prev : toggled(prev, relative)))
    } catch (e) { setError(errorText(e)) }
  }

  const submit = async () => {
    if (!selected.length || busy) return
    const next = orderMemberPaths([...members, ...selected])
    const invalid = memberSelectionError(next)
    if (invalid) return setError(invalid)
    setBusy(true); setError('')
    try { await updateGroup(project.id, { members: next }); onDone() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <div onKeyDown={(e) => { if (e.key === 'enter' && isPrimary(e.modifiers)) void submit() }} style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 20, paddingRight: 20, paddingTop: 20, paddingBottom: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Label color={t.text} size={17} lineHeight={22} weight={600}>{GROUP_COPY.addRepositoriesTitle(project.name)}</Label>
        <Label color={t.textSecondary} size={13} lineHeight={19}>{GROUP_COPY.addRepositoriesBody(folder)}</Label>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ChecklistHeader selected={selected.length} total={loading ? null : candidates.length} />
        <Checklist testId="repositories-checklist" maxHeight={Math.max(128, Math.min(420, window.height - 400))} candidates={candidates} selected={selected} loading={loading} onToggle={(p) => setSelected(toggled(selected, p))} empty={{ title: GROUP_COPY.nothingFoundTitle(group), body: GROUP_COPY.nothingFoundBody }} />
        {local && <div style={{ display: 'flex' }}><Button testId="repositories-add-folder" variant="ghost" size="sm" icon={N.plus} onClick={() => void addFolder()}>{GROUP_COPY.addFolder}</Button></div>}
        {error && <Label color={t.red} size={12} lineHeight={17}>{error}</Label>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button testId="repositories-add-cancel" variant="secondary" onClick={onDone}>{GROUP_COPY.cancel}</Button>
        <Button testId="repositories-add-submit" variant="primary" kbd="⌘↵" busy={busy} disabled={!selected.length && !busy} onClick={() => void submit()}>{GROUP_COPY.addRepositoriesButton(Math.max(1, selected.length))}</Button>
      </div>
    </div>
  )
}
