// Adding a project from the active space (§7.9): it lands in that space. A folder that is
// already a project elsewhere is left where it is, with a toast offering to bring it here.
import type { Project } from '../../../../packages/kybern-client/src/types.ts'
import { SPACE_COPY } from '../../../../packages/kybern-client/src/spaces.ts'
import { getClient, refreshLists, selectDraft } from '../state.ts'
import { setNav } from '../nav/store.ts'
import { toast } from '../shell/toasts.tsx'
import { currentSpaceId } from './current.ts'
import { getSpaces, moveProjectToSpace } from './store.ts'

function openDraft(project: Project) {
  setNav({ page: 'home' })
  selectDraft(project.id)
}

/** `projects.add` for the active space, then open the project's draft. Throws what the daemon says. */
export async function addProjectToCurrentSpace(path: string): Promise<Project | null> {
  const client = getClient()
  if (!client) throw new Error('Not connected')
  // Before `spaces.list` answers, the saved id is only a hint and may name a deleted space, which the daemon refuses.
  const spaceId = getSpaces().supported === true ? currentSpaceId() : null
  const project = await client.call('projects.add', { path, ...(spaceId ? { space_id: spaceId } : {}) })
  if (getClient() !== client) return null
  await refreshLists()
  const target = spaceId ? getSpaces().spaces.find((space) => space.id === spaceId) : undefined
  const elsewhere = target && project.space_id && project.space_id !== spaceId
  if (!elsewhere) {
    openDraft(project)
    return project
  }
  const owner = getSpaces().spaces.find((space) => space.id === project.space_id)
  toast(SPACE_COPY.alreadyIn(project.name, owner?.name ?? 'another space'), {
    action: { label: SPACE_COPY.moveHere, onClick: () => void moveProjectToSpace(project, target, { undo: false }).then((moved) => { if (moved) openDraft(project) }) },
  })
  return project
}
