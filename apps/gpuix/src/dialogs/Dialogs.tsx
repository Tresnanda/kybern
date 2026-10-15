import { useDialog, showDialog } from './store.ts'
import { Account } from './Account.tsx'
import { ProjectPicker } from './ProjectPicker.tsx'
import { WorktreeCleanup } from './WorktreeCleanup.tsx'

export function WorkspaceDialogs() {
  const dialog = useDialog()
  const close = () => showDialog(null)
  if (dialog?.kind === 'project') return <ProjectPicker close={close} />
  if (dialog?.kind === 'worktree') return <WorktreeCleanup key={dialog.threadId} threadId={dialog.threadId} close={close} />
  if (dialog?.kind === 'account') return <Account close={close} provider={dialog.provider} />
  return null
}
