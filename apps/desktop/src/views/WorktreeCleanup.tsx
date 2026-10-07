import { useEffect, useState } from "react"

import { Button } from "@/components/kit/button"
import { Checkbox } from "@/components/kit/checkbox"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@/components/kit/dialog"
import type { WorktreeInspectResult } from "@/protocol"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"

export function WorktreeCleanupDialog() {
  const threadId = useStore((s) => s.worktreeCleanupThread)
  return <Cleanup key={threadId ?? "closed"} threadId={threadId} />
}

function Cleanup({ threadId }: { threadId: string | null }) {
  const thread = useStore((s) => threadId ? s.threads[threadId] : null)
  const [inspection, setInspection] = useState<WorktreeInspectResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [force, setForce] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  const inspect = async (id: string) => {
    setError(null); setInspection(null); setForce(false); setDeleteBranch(false)
    try { setInspection(await rpc().call("threads.worktree.inspect", { thread_id: id })) }
    catch (e) { setError(errorText(e)) }
  }
  useEffect(() => {
    let current = true
    if (threadId) void rpc().call("threads.worktree.inspect", { thread_id: threadId }).then((result) => { if (current) setInspection(result) }).catch((e) => { if (current) setError(errorText(e)) })
    return () => { current = false }
  }, [threadId])
  const close = () => useStore.getState().set({ worktreeCleanupThread: null })
  const remove = async () => {
    if (!threadId) return
    setBusy(true); setError(null)
    try {
      setInspection(await rpc().call("threads.worktree.remove", { thread_id: threadId, force, delete_branch: deleteBranch }))
      setForce(false)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const unsafe = inspection && (!inspection.clean || !inspection.merged)
  return <Dialog open={threadId !== null} onOpenChange={(open) => { if (!open && !busy) close() }}><DialogPopup><DialogHeader><DialogTitle>{inspection?.exists === false ? "Worktree removed" : "Remove this worktree?"}</DialogTitle><DialogDescription>{thread?.title}. Keep this conversation and saved source. Continuing recreates its worktree.</DialogDescription></DialogHeader><div className="flex flex-col gap-3 px-4 py-3 text-[length:var(--app-font-size-ui,12px)] leading-relaxed">
    {error && <p role="alert" className="break-words text-destructive">{error} Refresh after resolving this issue.</p>}
    {!inspection && !error && <p role="status" className="text-muted-foreground">Checking worktree owners and source…</p>}
    {inspection && <><p className="break-all font-mono">{inspection.path}</p><p className="break-all">Branch: {inspection.branch}</p>{inspection.exists ? <>
      <p>{inspection.clean ? "Source is clean." : "Source has changes."} {inspection.merged ? "The branch is merged into the project checkout." : "The branch has commits that are not merged into the project checkout."}</p>
      {inspection.blockers.map((blocker) => <p key={blocker} className="text-destructive">{blocker}</p>)}
      {unsafe && <label className="flex items-start gap-2"><Checkbox checked={force} onCheckedChange={(checked) => setForce(checked === true)} className="mt-1" /><span>Remove the folder anyway. Save tracked and untracked source in a Git recovery ref first; restore it when this conversation continues. Keep unmerged commits on their branch.</span></label>}
      <label className="flex items-start gap-2"><Checkbox checked={deleteBranch} disabled={!inspection.merged} onCheckedChange={(checked) => setDeleteBranch(checked === true)} className="mt-1" /><span>Delete the merged branch. Keep the recovery ref so continuation can recreate it.</span></label>
      {inspection.ignored_files > 0 && <p className="text-muted-foreground">{inspection.ignored_files} ignored files remain. Move deliverables or remove build output before continuing.</p>}
    </> : <p role="status">The folder is removed. Your conversation and source recovery ref remain available.</p>}</>}
  </div><DialogFooter><Button variant="ghost" disabled={busy} onClick={close}>{inspection?.exists === false ? "Done" : "Keep worktree"}</Button>{inspection?.exists !== false && <><Button variant="secondary" disabled={busy || !threadId} onClick={() => threadId && void inspect(threadId)}>Refresh</Button><Button variant="destructive" disabled={busy || !inspection || inspection.blockers.length > 0 || (!!unsafe && !force)} onClick={() => void remove()}>{busy ? "Removing…" : force ? "Remove worktree anyway" : "Remove worktree"}</Button></>}</DialogFooter></DialogPopup></Dialog>
}
