// The two ways to add a project (L3 sheet 1): "Repository…" is today's flow (the system folder panel, or the folder
// browser on a remote daemon); "Group of repositories…" chooses the group folder the same way and then opens the
// checklist sheet. The sidebar "+" menu and the palette both call these.
import type { NativeRenderer } from '@gpuix/native/host'
import { GROUP_COPY } from '../../../../packages/kybern-client/src/groups.ts'
import { showDialog } from '../dialogs/store.ts'
import { addProject, errorText } from '../nav/actions.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { getState } from '../state.ts'

type Renderer = Pick<NativeRenderer, 'promptForPaths'> | null | undefined

export async function addRepository(renderer: Renderer) {
  if (getState().status !== 'open') return
  if (!activeEnvironment().local) return showDialog({ kind: 'project' })
  const paths = await renderer?.promptForPaths?.({ directories: true, files: false, prompt: 'Add project' })
  if (paths?.[0]) await addProject(paths[0]).catch((e) => console.error('[sidebar] Unable to add project:', errorText(e)))
}

export async function addGroup(renderer: Renderer) {
  if (getState().status !== 'open') return
  if (!activeEnvironment().local) return showDialog({ kind: 'project', group: true })
  const paths = await renderer?.promptForPaths?.({ directories: true, files: false, prompt: GROUP_COPY.chooseGroupFolder })
  if (paths?.[0]) showDialog({ kind: 'group', path: paths[0] })
}
