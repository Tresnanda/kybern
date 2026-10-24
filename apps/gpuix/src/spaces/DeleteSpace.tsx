// The confirm dialog for deleting a space (`docs/specs/spaces.md` §7.8).
import { useState } from 'react'
import { SPACE_COPY, canDeleteSpace, deleteTarget } from '../../../../packages/kybern-client/src/spaces.ts'
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../kit/AlertDialog.tsx'
import { getNav, setNav } from '../nav/store.ts'
import { toast } from '../shell/toasts.tsx'
import { useApp } from '../state.ts'
import { currentSpaceId } from './current.ts'
import { deleteSpace, useSpaces } from './store.ts'
import { closeDeleteSpace, useSpaceUi } from './ui.ts'

export function DeleteSpace() {
  const id = useSpaceUi((s) => s.deleting)
  const spaces = useSpaces((s) => s.spaces)
  const projects = useApp((s) => s.projects)
  // The dialog keeps its words while it fades out.
  const [shown, setShown] = useState<string | null>(null)
  if (id && id !== shown) setShown(id)
  const space = spaces.find((candidate) => candidate.id === (id ?? shown))
  if (!space) return null
  // The menu disables Delete for the default space; this keeps a stale request from asking.
  if (!canDeleteSpace(space)) return null
  const target = deleteTarget(spaces, space.id)
  const inside = projects.filter((project) => project.space_id === space.id)
  const description =
    inside.length === 0 ? SPACE_COPY.deleteNone
    : inside.length === 1 ? SPACE_COPY.deleteOne(inside[0]!.name, target?.name ?? '')
    : SPACE_COPY.deleteMany(inside.length, target?.name ?? '')
  const confirm = async () => {
    const wasActive = currentSpaceId() === space.id
    try {
      const result = await deleteSpace(space.id)
      const spaceViews = { ...getNav().spaceViews }
      delete spaceViews[space.id]
      // The open view now belongs to the target (the follow rule agrees); a page stays on it.
      setNav({ spaceViews, ...(wasActive || getNav().spaceId === space.id ? { spaceId: result.moved_to } : {}) })
      toast(SPACE_COPY.deletedToast(space.name))
    } catch {
      toast.error(SPACE_COPY.deleteFailure)
    }
  }
  return (
    <AlertDialog open={!!id} onOpenChange={(open) => { if (!open) closeDeleteSpace() }} width={448} testId="delete-space">
      <AlertDialogHeader>
        <AlertDialogTitle>{SPACE_COPY.deleteTitle(space.name)}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose variant="outline" testId="delete-space-cancel">{SPACE_COPY.cancel}</AlertDialogClose>
        <AlertDialogClose variant="destructive" testId="delete-space-confirm" onClick={() => void confirm()}>{SPACE_COPY.deleteConfirm}</AlertDialogClose>
      </AlertDialogFooter>
    </AlertDialog>
  )
}
