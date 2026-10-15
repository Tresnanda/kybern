import { useEffect, useState } from 'react'
import type { WorktreeInspectResult } from '../../../../packages/kybern-client/src/types.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { Button, Switch } from '../settings/controls.tsx'
import { getClient, refreshLists, useApp } from '../state.ts'
import { errorText } from '../nav/actions.ts'
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
  return <Dialog onClose={dismiss} width={512} testId="worktree-cleanup"><DialogHeader title={inspection?.exists === false ? 'Worktree removed' : 'Remove this worktree?'} description={`${thread?.title ?? 'This thread'}. Keep this conversation and saved source. Continuing recreates its worktree.`} onClose={dismiss} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      {error && <Label color={t.red} size={12}>{`${error} Refresh after resolving this issue.`}</Label>}
      {!inspection && !error && <Label color={t.textSecondary} size={12}>Checking worktree owners and source…</Label>}
      {inspection && <><Label color={t.textSecondary} size={12}>{inspection.path}</Label><Label color={t.text} size={12}>{`Branch: ${inspection.branch}`}</Label>
        {inspection.exists ? <>
          <Label color={t.text} size={12} lineHeight={18}>{`${inspection.clean ? 'Source is clean.' : 'Source has changes.'} ${inspection.merged ? 'The branch is merged into the project checkout.' : 'The branch has commits that are not merged into the project checkout.'}`}</Label>
          {inspection.blockers.map((blocker) => <Label key={blocker} color={t.red} size={12}>{blocker}</Label>)}
          {unsafe && <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><Switch testId="worktree-force" label="Remove the folder anyway" checked={force} onChange={setForce} disabled={busy} /><Label color={t.text} size={12} lineHeight={18} style={{ flexShrink: 1 }}>Remove the folder anyway. Save tracked and untracked source in a Git recovery ref first; restore it when this conversation continues. Keep unmerged commits on their branch.</Label></div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><Switch testId="worktree-delete-branch" label="Delete the merged branch" checked={deleteBranch} onChange={setDeleteBranch} disabled={busy || !inspection.merged} /><Label color={t.text} size={12} lineHeight={18} style={{ flexShrink: 1 }}>Delete the merged branch. Keep the recovery ref so continuation can recreate it.</Label></div>
          {inspection.ignored_files > 0 && <Label color={t.textSecondary} size={12}>{`${inspection.ignored_files} ignored files remain. Move deliverables or remove build output before continuing.`}</Label>}
        </> : <Label color={t.text} size={12}>The folder is removed. Your conversation and source recovery ref remain available.</Label>}
      </>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button disabled={busy} onClick={dismiss}>{inspection?.exists === false ? 'Done' : 'Keep worktree'}</Button>{inspection?.exists !== false && <><Button disabled={busy} onClick={() => setReload((n) => n + 1)}>Refresh</Button><Button testId="worktree-remove" disabled={busy || !inspection || inspection.blockers.length > 0 || (!!unsafe && !force)} onClick={() => void remove()}>{busy ? 'Removing…' : force ? 'Remove worktree anyway' : 'Remove worktree'}</Button></>}</div>
    </div>
  </Dialog>
}
