import { useDialog, showDialog } from './store.ts'
import { Account } from './Account.tsx'
import { ProjectPicker } from './ProjectPicker.tsx'
import { GroupProject } from './GroupProject.tsx'
import { Repositories } from './Repositories.tsx'
import { WorktreeCleanup } from './WorktreeCleanup.tsx'
import { AntigravityNotice } from '../antigravity/Notice.tsx'
import { ForkSheet } from '../fork/ForkSheet.tsx'
import { ProvisionSheet } from '../provision/ProvisionSheet.tsx'

export function WorkspaceDialogs() {
  const dialog = useDialog()
  const close = () => showDialog(null)
  if (dialog?.kind === 'project') return <ProjectPicker key={dialog.group ? 'group' : 'single'} close={close} group={dialog.group} />
  if (dialog?.kind === 'group') return <GroupProject key={dialog.path} path={dialog.path} close={close} />
  if (dialog?.kind === 'repositories') return <Repositories key={dialog.projectId} projectId={dialog.projectId} close={close} />
  if (dialog?.kind === 'worktree') return <WorktreeCleanup key={dialog.threadId} threadId={dialog.threadId} close={close} />
  if (dialog?.kind === 'fork') return <ForkSheet key={`${dialog.machineId ?? ''}:${dialog.threadId}`} threadId={dialog.threadId} {...(dialog.machineId ? { machineId: dialog.machineId } : {})} close={close} />
  if (dialog?.kind === 'move') return <ForkSheet key={`move:${dialog.machineId ?? ''}:${dialog.threadId}`} mode="move" threadId={dialog.threadId} {...(dialog.machineId ? { machineId: dialog.machineId } : {})} close={close} />
  if (dialog?.kind === 'provision') return <ProvisionSheet key={`provision:${dialog.machineId ?? ''}:${dialog.projectId}`} projectId={dialog.projectId} {...(dialog.machineId ? { machineId: dialog.machineId } : {})} close={close} />
  if (dialog?.kind === 'antigravity-notice') return <AntigravityNotice proceed={dialog.proceed} close={close} />
  if (dialog?.kind === 'account') return <Account key={`${dialog.provider ?? ''}:${dialog.instance ?? ''}`} close={close} provider={dialog.provider} instance={dialog.instance} />
  return null
}
