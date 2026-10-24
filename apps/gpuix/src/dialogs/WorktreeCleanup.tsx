import { useEffect, useState } from 'react'
import type { WorktreeInspectResult } from '../../../../packages/kybern-client/src/types.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { N } from '../nav/glyphs.ts'
import { Button } from '../kit/Button.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { getClient, refreshLists, useApp } from '../state.ts'
import { errorText } from '../nav/actions.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'

export function WorktreeCleanup({ threadId, close }: { threadId: string; close: () => void }) {
  const t = useTheme()
  const thread = useApp((s) => s.threads.find((th) => th.id === threadId))
  const [client] = useState(() => getClient()!)
  const [inspection, setInspection] = useState<WorktreeInspectResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [force, setForce] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    setError(''); setInspection(null); setForce(false); setDeleteBranch(false)
    void client.call('threads.worktree.inspect', { thread_id: threadId }).then((next) => { if (live) setInspection(next) }, (e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, threadId, reload])
  const remove = async () => {
    setBusy(true); setError('')
    try { const next = await client.call('threads.worktree.remove', { thread_id: threadId, force, delete_branch: deleteBranch }); setInspection(next); setForce(false); if (getClient() === client) void refreshLists() }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const unsafe = inspection && (!inspection.clean || !inspection.merged)
  const dismiss = () => { if (!busy) close() }
  // A title that already ends a sentence ("…ok.", a truncated "…") takes no second full stop.
  const title = thread?.title ?? 'This thread'
  const lead = /[.!?…]$/.test(title) ? title : `${title}.`
  return <Dialog onClose={dismiss} width={512} testId="worktree-cleanup"><DialogHeader title={inspection?.exists === false ? 'Worktree removed' : 'Remove this worktree?'} description={`${lead} Keep this conversation and saved source. Continuing recreates its worktree.`} onClose={dismiss} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft:16, paddingRight:16, paddingTop:12, paddingBottom:12 }}>
      {error && <Label color={t.red} size={14}>{`${error} Refresh after resolving this issue.`}</Label>}
      {!inspection && !error && <Label color={t.textSecondary} size={14}>Checking worktree owners and source…</Label>}
      {inspection && <><Label color={t.text} size={14} lineHeight={22} font={FONT_MONO}>{inspection.path}</Label><Label color={t.text} size={14}>{`Branch: ${inspection.branch}`}</Label>
        {inspection.exists ? <>
          <Label color={t.text} size={14} lineHeight={22}>{`${inspection.clean ? 'Source is clean.' : 'Source has changes.'} ${inspection.merged ? 'The branch is merged into the project checkout.' : 'The branch has commits that are not merged into the project checkout.'}`}</Label>
          {inspection.blockers.map((blocker) => <Label key={blocker} color={t.red} size={14}>{blocker}</Label>)}
          {unsafe && <CheckRow testId="worktree-force" label="Remove the folder anyway" checked={force} onChange={setForce} disabled={busy}>Remove the folder anyway. Save tracked and untracked source in a Git recovery ref first; restore it when this conversation continues. Keep unmerged commits on their branch.</CheckRow>}
          <CheckRow testId="worktree-delete-branch" label="Delete the merged branch" checked={deleteBranch} onChange={setDeleteBranch} disabled={busy || !inspection.merged}>Delete the merged branch. Keep the recovery ref so continuation can recreate it.</CheckRow>
          {inspection.ignored_files > 0 && <Label color={t.textSecondary} size={14}>{`${inspection.ignored_files} ignored files remain. Move deliverables or remove build output before continuing.`}</Label>}
        </> : <Label color={t.text} size={14}>The folder is removed. Your conversation and source recovery ref remain available.</Label>}
      </>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>{inspection?.exists === false ? <Button size="lg" variant="primary" disabled={busy} onClick={dismiss}>Done</Button> : <><Button size="lg" variant="ghost" icon={N.refresh} disabled={busy} onClick={() => setReload((n) => n + 1)}>Refresh</Button><div style={{ flexGrow: 1 }} /><Button size="lg" variant="secondary" disabled={busy} onClick={dismiss}>Keep worktree</Button><Button size="lg" variant="destructive" testId="worktree-remove" disabled={busy || !inspection || inspection.blockers.length > 0 || (!!unsafe && !force)} onClick={() => void remove()}>{busy ? 'Removing…' : force ? 'Remove worktree anyway' : 'Remove worktree'}</Button></>}</div>
    </div>
  </Dialog>
}

/** A kit checkbox and its sentence: the sentence is part of the hit area. */
function CheckRow({ checked, onChange, label, disabled, testId, children }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; testId?: string; children: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
    <Checkbox testId={testId} aria-label={label} checked={checked} onCheckedChange={onChange} disabled={disabled} style={{ marginTop: 3 }} />
    <div onClick={() => { if (!disabled) onChange(!checked) }} style={{ display: 'flex', flexBasis: 0, flexGrow: 1, minWidth: 0, cursor: disabled ? 'default' : 'pointer' }}><Label color={disabled ? t.textTertiary : t.text} size={14} lineHeight={22} style={{ flexBasis: 0, flexGrow: 1, minWidth: 0 }}>{children}</Label></div>
  </div>
}
